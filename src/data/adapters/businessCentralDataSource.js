// src/data/adapters/businessCentralDataSource.js
const ApiError = require('../../utils/apiError');
const logger = require('../../utils/logger');

/**
 * SERIAL-TRACKED LINES ARE FULFILLED BY SCANNING THEIR SERIAL.
 *
 * Business Central reports isScannable: false for serial-tracked lines
 * (confirmed on WHPA-000170 and WHPA-000171) even though its own doc says
 * the flag is "effectively always true". isScannable is about whether an
 * ITEM barcode could be resolved; a serial-tracked line is identified by
 * the SERIAL on the unit itself, which is a different thing — and the
 * line already carries exactly the value a scan must match (serialNo).
 * Leaving such a line "not scannable" sent it down the manual-quantity
 * path, where several same-sku serial lines shared one entry field (the
 * "Total handled quantity (2) exceeds the line quantity (1)" rejection on
 * WHPA-149) and the operator had to repeat bin -> item for every unit.
 *
 * So a serial-tracked line that carries a serial number is treated as
 * scannable. A serial-tracked line WITHOUT a serial number stays as
 * Business Central reported it (nothing to match a scan against), and a
 * non-serial line flagged unscannable (an item with no barcode at all —
 * the electricity-pole case) is untouched.
 *
 * Set SERIAL_LINES_SCANNABLE=false to go back to using Business Central's
 * flag verbatim for serial lines.
 */
const SERIAL_LINES_SCANNABLE = process.env.SERIAL_LINES_SCANNABLE !== 'false';

/**
 * PUT-AWAY REGISTER IS MANUAL ONLY.
 *
 * confirmPutAwayBatch only SAVES scans to Business Central — it never
 * registers. Per product decision, Register runs only when the operator
 * taps the Register button in the app, and the app only offers that
 * button once every line of the document is saved to Business Central
 * (see PutAwayRepository.registerDocumentAwaited). The old automatic
 * paths — register when the last bin lands (_tryAutoRegister) and the
 * PUT_AWAY_REGISTER_PER_BIN "register as you go" switch — are removed.
 * PUT_AWAY_REGISTER_PER_BIN is now ignored if still set in .env.
 */

/**
 * How long Item Inquiry keeps the Section 2.3 item catalog (GET items)
 * before downloading it again — see _getItemCatalog. 10 minutes by
 * default; ITEM_CATALOG_TTL_MS overrides it (0 = always re-download).
 */
const ITEM_CATALOG_TTL_MS = Number.isFinite(Number(process.env.ITEM_CATALOG_TTL_MS))
  ? Number(process.env.ITEM_CATALOG_TTL_MS)
  : 10 * 60 * 1000;

/// Business Central decimals arrive as numbers, but be safe with strings
/// and blanks — a missing quantity is 0, never NaN.
function toNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Implements the exact same method surface as DemoDataSource (see
 * dataSource.interface.js) so that flipping DATA_SOURCE=businessCentral in
 * .env is the *only* change needed to switch — no route or controller code
 * changes.
 *
 * CURRENT SCOPE (last updated 2026-09): implemented against real Business
 * Central data — getPutAwayDocuments/getPutAwayDocument (read),
 * confirmPutAwayItem (Section 2.5's PATCH), registerPutAway (Section
 * 2.6's Register action), searchBin/listBins (Section 2.2's GET /Bins),
 * and checkPutAwayBin (built on the SAME GET /Bins lookup searchBin
 * uses — see checkPutAwayBin's own doc for exactly what that can and
 * can't answer compared to the mocked demo version). Pick (2026-10):
 * getPickDocuments/getPickDocument (v2 doc Section 2.5), confirmPickItem
 * (2.9 UpdateLineScan), confirmPickBatch (2.10 ProcessBatchScans + 2.11
 * Register) and registerPick (2.11) — see the Pick section below.
 * Item Inquiry (2026-10): searchItem (Section 2.3.1 itemInquiries, by
 * barcode, then item number, then name via the 2.3 catalog).
 *
 * Still `_notImplemented()`: validatePutAwayBin/suggestPutAwayBin. Not an
 * oversight — the documented /Bins endpoint has no capacity field, so
 * there's no way to answer "does this bin have room for N units" against
 * real data, only "is it empty." Those stay mocked (DATA_SOURCE=demo)
 * until a capacity-aware endpoint is documented — deliberately NOT
 * downgraded to a weaker "best effort" implementation against data that
 * can't actually support them.
 *
 * Auth is HTTP Basic (username + Business Central Web Service Access Key),
 * not OAuth2 — see _bcGet below.
 *
 * PUT-AWAY QUANTITIES (see _mapPutAway for the implementation) — only
 * Place lines drive quantity and status; Take lines are informational
 * (they supply receivedFromLocation, nothing else). Each Place line
 * carries three fields that matter:
 *   quantity       — the line's full quantity.
 *   qtyHandled     — how much Business Central has already handled.
 *   qtyOutstanding — how much is left, i.e. what the operator still has
 *                    to scan. Returned to the app as qtyToHandle.
 * A line with qtyHandled == quantity (qtyOutstanding 0) needs nothing
 * from the operator, and a document in which EVERY line is like that is
 * a candidate for registering (status 'complete'). This replaces the
 * older Take.qtyToHandle - Place.qtyToHandle subtraction, which could
 * not tell an untouched line from a finished one.
 *
 * PUT-AWAY SPLITTING, REGISTERING AND BINS (KIMS-WM API doc Sections
 * 2.6, 2.7, 2.8 and the Notes for Integrators):
 *   - Business Central performs every split itself. A scan (single
 *     PATCH or a batch entry) for a line with a DIFFERENT bin than the
 *     line's current one, while the line is PARTIALLY handled, creates a
 *     new line for the remaining quantity on the new bin; the original
 *     keeps what was handled, on its original bin. A different-bin scan
 *     on a line with nothing handled yet, or one already fully handled,
 *     fails ("Cannot execute split logic ..."). The same bin simply
 *     accumulates. This adapter never builds a split line itself.
 *   - A line is addressed by its id (SystemId) ALONE. lineNo is not
 *     stable — a split creates a new line and shifts numbering — and a
 *     split's response returns only the original line; re-GET with
 *     $expand=putAwayLines to see the new one. Only Place lines can be
 *     scanned; a serial-tracked line (quantity 1) can never be partially
 *     handled, so it can never split. Lot and serial numbers need not be
 *     sent: the id alone resolves the line, and a split carries them over.
 *   - The batch (ProcessBatchScans) is all-or-nothing per call and
 *     processes its entries strictly in order; the same id may repeat.
 *   - The ONLY bin rule in the doc is that the bin must exist at the
 *     put-away's location. There is no empty-bin or capacity rule, so
 *     none is applied here: checkPutAwayBin and validatePutAwayBin
 *     accept any bin recognized at the location, empty or not. Anything
 *     Business Central itself restricts is enforced by Business Central
 *     when the scan is pushed, and reported back verbatim.
 *   - Register posts whatever quantity is currently set to handle on
 *     each line and leaves the rest outstanding (qtyHandled /
 *     qtyOutstanding). That is what lets the app's Split Bin push and
 *     register part of a line while the document is still in progress.
 *     Observed against WHPA-000169, and not described by the doc:
 *     Register was rejected ("Bin Code must have a value ... Line
 *     No.=40000") while ANOTHER line on the same document had a quantity
 *     to handle and no bin yet.
 */
class BusinessCentralDataSource {
  constructor(config) {
    this.config = config;
  }

  _notImplemented(method) {
    throw ApiError.internal(
      `Business Central integration for "${method}" is not implemented yet. Set DATA_SOURCE=demo in .env until it is.`,
      'BC_NOT_IMPLEMENTED',
    );
  }

  /// Shared GET helper for every Business Central call: composes the
  /// company-scoped URL, attaches the Basic Auth header, and surfaces a
  /// clear config error at call time (not a cryptic "fetch failed") if
  /// BC_BASE_URL/BC_COMPANY_ID/BC_USERNAME/BC_PASSWORD aren't all set —
  /// belt-and-suspenders alongside config/env.js's own boot-time check,
  /// in case this adapter is ever constructed with a partial config
  /// object in a test or script rather than through dataSourceFactory.
  async _bcGet(pathAndQuery) {
    const { baseUrl, companyId, username, password } = this.config || {};
    if (!baseUrl || !companyId || !username || !password) {
      throw ApiError.internal(
        'Business Central is not fully configured — check BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME, and BC_PASSWORD in .env.',
        'BC_NOT_CONFIGURED',
      );
    }

    const url = `${baseUrl}/companies(${companyId})/${pathAndQuery}`;
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    let response;
    try {
      response = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
    } catch (error) {
      throw ApiError.internal(`Could not reach Business Central: ${error.message}`, 'BC_NETWORK_ERROR');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw ApiError.internal(
        `Business Central returned ${response.status} for ${pathAndQuery}${body ? `: ${body}` : ''}`,
        'BC_REQUEST_FAILED',
      );
    }

    return response.json();
  }

  /// PATCH counterpart to _bcGet, for POST /put-away/confirm's Business
  /// Central mapping (Section 2.5, "Update Put-Away Line"). If-Match: *
  /// is sent unconditionally — this app doesn't hold onto a prior GET's
  /// @odata.etag for a line before confirming it, so last-write-wins
  /// concurrency (which "*" opts into) is the only option available; the
  /// alternative (a real etag) would mean re-fetching the line
  /// immediately before every confirm, which isn't worth the extra round
  /// trip for a field this app doesn't otherwise need.
  async _bcPatch(pathAndQuery, body) {
    const { baseUrl, companyId, username, password } = this.config || {};
    if (!baseUrl || !companyId || !username || !password) {
      throw ApiError.internal(
        'Business Central is not fully configured — check BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME, and BC_PASSWORD in .env.',
        'BC_NOT_CONFIGURED',
      );
    }

    const url = `${baseUrl}/companies(${companyId})/${pathAndQuery}`;
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'If-Match': '*',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw ApiError.internal(`Could not reach Business Central: ${error.message}`, 'BC_NETWORK_ERROR');
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      const message =
        `Business Central rejected the put-away line update (${response.status}) for ${pathAndQuery}` +
        `${responseBody ? `: ${responseBody}` : ''}`;
      // Same fix as _bcPost's identical bug — preserve BC's own 4xx/5xx
      // distinction instead of always wrapping as this middleware's own
      // 500, which made a genuinely permanent BC validation rejection
      // (exceeding line quantity, an invalid mid-line bin change) look
      // like a transient server error to the app's SyncManager, causing
      // it to retry the identical failing payload forever instead of
      // marking it rejected.
      if (response.status >= 400 && response.status < 500) {
        throw ApiError.badRequest(message);
      }
      throw ApiError.internal(message, 'BC_CONFIRM_REJECTED');
    }

    return response.json();
  }

  /// POST counterpart to _bcGet/_bcPatch — for invoking a bound Business
  /// Central ACTION, not creating a resource. No If-Match header (actions
  /// aren't optimistic-concurrency-checked the way updating a resource
  /// is), and the body is genuinely empty for every action this app calls
  /// today (Section 2.6, Register Put-Away). A successful response can be
  /// empty too — 200 or 204 with no body is normal for a NAV/BC action
  /// invocation, so this only tries to parse JSON when the response
  /// actually looks like it has content.
  async _bcPost(pathAndQuery, body) {
    const { baseUrl, companyId, username, password } = this.config || {};
    if (!baseUrl || !companyId || !username || !password) {
      throw ApiError.internal(
        'Business Central is not fully configured — check BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME, and BC_PASSWORD in .env.',
        'BC_NOT_CONFIGURED',
      );
    }

    const url = `${baseUrl}/companies(${companyId})/${pathAndQuery}`;
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
      });
    } catch (error) {
      throw ApiError.internal(`Could not reach Business Central: ${error.message}`, 'BC_NETWORK_ERROR');
    }

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      const message =
        `Business Central rejected the action call (${response.status}) for ${pathAndQuery}` +
        `${responseBody ? `: ${responseBody}` : ''}`;
      // Preserve BC's own 4xx/5xx distinction — this previously always
      // threw ApiError.internal (mapped to this middleware's own 500)
      // regardless of what BC actually said, so a genuine, PERMANENT
      // validation rejection from BC (400 — "will never succeed by
      // retrying the identical payload," e.g. "Total handled quantity
      // exceeds the line quantity" or "Bin Code must have a value")
      // looked identical, from the app's SyncManager's point of view, to
      // a transient server error. SyncManager only marks an entry
      // permanently rejected (stops retrying) for a 4xx-class
      // ApiRequestException; a 5xx is retried with backoff forever.
      // Confirmed real: both a batch-scan rejection and a Register
      // rejection kept retrying every sync cycle indefinitely — the
      // exact same failing payload, resent over and over, for a call
      // that could never succeed without the underlying data actually
      // changing first.
      if (response.status >= 400 && response.status < 500) {
        throw ApiError.badRequest(message);
      }
      throw ApiError.internal(message, 'BC_ACTION_REJECTED');
    }

    const rawText = await response.text().catch(() => '');
    if (!rawText) return {};
    try {
      return JSON.parse(rawText);
    } catch {
      return {};
    }
  }

  /// Maps one Business Central putAway (with its expanded putAwayLines)
  /// onto the app's PutAwayDocument shape. Three assumptions made here
  /// are flagged explicitly rather than silently guessed — see each
  /// inline comment:
  _mapPutAway(bc) {
    const lines = bc.putAwayLines || [];
    const takeLines = lines.filter((l) => l.actionType === 'Take');
    const placeLines = lines.filter((l) => l.actionType === 'Place');

    // ASSUMPTION: Take lines are informational only (per product
    // decision — the operator just needs to see where to take the item
    // FROM, not scan/confirm that step) and collapse to the single
    // document-level receivedFromLocation the app already models. Falls
    // back to the generic 'RECEIVING' label demoDataSource.js also
    // defaults to when every Take line's binCode is blank, which the one
    // sample in the API doc shows as the normal case.
    const firstTakeBin = takeLines.map((l) => l.binCode).find((c) => c && c.trim());
    const receivedFromLocation = firstTakeBin || 'RECEIVING';

    // PUT-AWAY QUANTITIES — Place lines only (full rule in this file's
    // top-of-file doc). Per product decision, the earlier Take/Place
    // qtyToHandle subtraction is gone: Business Central now exposes
    // qtyHandled and qtyOutstanding directly on every line, so there is
    // nothing left to infer. Take lines are not consulted for quantity
    // at all (they still feed receivedFromLocation below). Per Place
    // line:
    //   - qtyOutstanding is what the operator still has to scan, and is
    //     what the app receives as qtyToHandle.
    //   - qtyHandled == quantity (qtyOutstanding 0) means there is
    //     nothing left for the operator to do on that line — which is
    //     also what makes the line a candidate for registering (see the
    //     document status below).
    // Defensive fallback ONLY if a line somehow arrives without
    // qtyOutstanding: derived as quantity - qtyHandled, with a missing
    // qtyHandled read as 0 — so a line with neither field reports its
    // FULL quantity as outstanding. That errs toward "operator still has
    // work to do," never toward silently reporting a line as done, which
    // is the failure this replaces (see the status comment below).
    const items = placeLines.map((line) => {
      const qtyHandled = typeof line.qtyHandled === 'number' ? line.qtyHandled : 0;
      const qtyToHandle =
        typeof line.qtyOutstanding === 'number' ? line.qtyOutstanding : Math.max(0, line.quantity - qtyHandled);
      return {
      sku: line.itemNo,
      description: line.itemDesc,
      qty: line.quantity,
      // A blank binCode on a Place line is exactly what
      // PutAwayLineItem.location == null already means — Business
      // Central did not pre-assign a destination, operator chooses one
      // on the floor. Mapping it straight to null is what makes that
      // existing flow apply to real BC data with no extra logic.
      location: line.binCode && line.binCode.trim() ? line.binCode : null,
      // Previously hardcoded true — the original API doc had no
      // equivalent field. The v2 update added isScannable directly on
      // the line, so this now reads real data instead of assuming every
      // item can be barcode-scanned. Per product decision, some items
      // (e.g. electricity poles stored in an open floor space, tagged
      // only with a wall plate) have no barcode reference configured in
      // BC at all — isScannable false for those, driving the manual
      // bin+SKU+quantity entry path instead of the scan loop.
      // A serial-tracked line with a known serial is scanned by that serial
      // even when Business Central's own flag says false — see
      // SERIAL_LINES_SCANNABLE at the top of this file for why.
      scannable:
        line.isScannable !== false ||
        (SERIAL_LINES_SCANNABLE && line.isSerialTracked === true && !!(line.serialNo && String(line.serialNo).trim())),
      // New in the v2 doc update — drives which scan mode the app uses
      // for this line. isSerialTracked: each physical unit must be
      // scanned individually and the operator can never bulk-count it
      // (a serial can't be "entered as a quantity"); isLotTracked: the
      // existing scan-and-count behavior, unchanged. Neither field
      // implies the other — an item can in principle be untracked,
      // lot-tracked, or serial-tracked, never more than one at once per
      // the doc's description.
      isSerialTracked: line.isSerialTracked === true,
      isLotTracked: line.isLotTracked === true,
      // Only ever populated by Business Central itself on a line that's
      // ALREADY been handled and read back — never something the app
      // sends. Local serial capture during scanning is tracked
      // separately (see scan_log_entries), not through this field.
      lotNo: line.lotNo || null,
      serialNo: line.serialNo || null,
      // Business Central's own line GUID — required to address PATCH
      // .../putAwayLines(bcLineId) when this line is confirmed (Section
      // 2.5). The app carries this through untouched even across a
      // LOCAL split (see PutAwayLineItem.splitShort) — both the settled
      // and remainder halves target this same original line id, which
      // is exactly what triggers Business Central's OWN server-side
      // split when the second PATCH arrives with a different bin.
      bcLineId: line.id,
      // What the operator still has to scan on this line — BC's own
      // qtyOutstanding (see the PUT-AWAY QUANTITIES comment above).
      // qty stays the line's full quantity; the gap between the two is
      // what BC has already handled.
      qtyToHandle,
      };
    });

    // ASSUMPTION: the putAways endpoint itself has no status field.
    // Inferred here from each Place line's qtyOutstanding (surfaced as
    // qtyToHandle — see items' own definition above); still just a
    // read-time snapshot of BC's state, not the app's own source of
    // truth for an in-progress document (the local outbox is):
    //   complete   — every line fully handled (qtyHandled == quantity,
    //                qtyOutstanding 0). Nothing left for the operator to
    //                scan; the document is a candidate for registering.
    //   assigned   — every line untouched (qtyOutstanding == quantity).
    //   inProgress — anything in between.
    //
    // SUPERSEDES two earlier theories, both disproven by real data. The
    // first inferred "done" from whether a bin was assigned; the second
    // from Take.qtyToHandle minus Place.qtyToHandle. The second read
    // WHPA-000169 as complete while its 8-unit PFL89677 line had never
    // been touched (Take and Place both carried 8, so the difference
    // collapsed to 0), which is what sent Microsoft.NAV.Register a
    // document it then rejected: "Bin Code must have a value ... Line
    // No.=40000". qtyHandled/qtyOutstanding make that inference
    // unnecessary.
    const allDone = items.length > 0 && items.every((i) => i.qtyToHandle === 0);
    const allUntouched = items.every((i) => i.qtyToHandle === i.qty);
    const status = allDone ? 'complete' : allUntouched ? 'assigned' : 'inProgress';

    return {
      docId: bc.no,
      // Business Central's own put-away header GUID — required to
      // address PATCH .../putAways(bcPutAwayId)/putAwayLines(...) for
      // every line on this document.
      bcPutAwayId: bc.id,
      // Which BC warehouse location this put-away belongs to (Section
      // 2.4's header field). Never captured before this fix — that gap
      // is exactly what let checkPutAwayBin return a false "available"
      // for a bin that only existed in a DIFFERENT location's Bin table:
      // GET /Bins?$filter=binCode eq 'X' with no location scoping can
      // match a same-named bin anywhere, but the actual PATCH .../
      // putAwayLines call validates the bin against the LINE's real
      // location and correctly rejects it if it's not there. See
      // checkPutAwayBin's own doc for the fix.
      locationCode: bc.locationCode,
      // ASSUMPTION: no field in the documented schema maps cleanly to
      // this. Using the first Take line's SourceDoc (e.g. "Inbound
      // Transfer") as the closest available descriptor, falling back to
      // the put-away's own number. Flagged as a guess, not a confirmed
      // mapping — worth revisiting once/if BC exposes a real warehouse
      // receipt reference.
      sourceWarehouseReceipt: takeLines[0]?.SourceDoc || bc.no,
      status,
      items,
      receivedFromLocation,
    };
  }

  async getPutAwayDocuments() {
    const data = await this._bcGet('putAways?$expand=putAwayLines');
    // TEMPORARY diagnostic aid — logs the exact, unmapped response
    // Business Central sent, before _mapPutAway touches any of it. Added
    // specifically to verify the v2 doc's new putAwayLines fields
    // (isSerialTracked, isLotTracked, lotNo, serialNo, isScannable)
    // against real data rather than trusting the doc's wording — see the
    // isScannable "effectively always true" discrepancy raised earlier
    // in this project. Worth removing (or dropping to logger.debug) once
    // that's confirmed; this is meant to be watched in the console
    // during verification, not to run at info level in production
    // indefinitely.
    logger.info({ rawBcResponse: data }, 'Raw Business Central response — GET putAways?$expand=putAwayLines');
    return { documents: (data.value || []).map((d) => this._mapPutAway(d)) };
  }

  async getPutAwayDocument(docId) {
    // OData string literals are single-quoted; a literal single quote in
    // docId must be doubled per OData escaping convention. Real BC
    // put-away numbers (e.g. "WHPA-000063") won't contain one, but
    // escaping costs nothing and avoids a malformed query if one ever
    // does.
    const escaped = String(docId).replace(/'/g, "''");
    const data = await this._bcGet(`putAways?$expand=putAwayLines&$filter=no eq '${escaped}'`);
    // Same temporary diagnostic as getPutAwayDocuments above.
    logger.info({ docId, rawBcResponse: data }, 'Raw Business Central response — GET putAways (single document)');
    const match = (data.value || [])[0];
    if (!match) throw ApiError.notFound(`Put away document "${docId}" not found.`);
    return this._mapPutAway(match);
  }

  /// Maps onto Section 2.5, "Update Put-Away Line (Scan-to-Bin)" — PATCH
  /// .../putAways(bcPutAwayId)/putAwayLines(bcLineId), body
  /// {binCode, qtyToHandle}.
  ///
  /// IMPORTANT — qtyToHandle is INCREMENTAL on Business Central's side,
  /// not a running total, but this method still receives the app's full
  /// FINAL qty for the line (same as the demo adapter always has) and
  /// sends it as a single PATCH. That's correct, not a mismatch: the
  /// app's own local-first flow (PutAwayItemController) already
  /// accumulates every individual scan LOCALLY and only calls this once
  /// per line, against a line Business Central has never seen a PATCH
  /// for yet — sending the full local qty as "the increment" against an
  /// untouched line has the identical effect to a single confirm. A
  /// LOCAL split (Stop & Split) becomes exactly two calls into this
  /// method, both carrying the SAME bcLineId (see PutAwayLineItem.
  /// splitShort's doc) — first the settled qty against the original
  /// bin, then the remainder qty against the new bin. That second call
  /// is precisely Business Central's own "different bin, partially
  /// handled" case, which is what triggers ITS server-side split — the
  /// app never tells Business Central about a split directly, it just
  /// naturally falls out of sending two real PATCH calls in sequence
  /// against the same line.
  ///
  /// Requires bcPutAwayId/bcLineId in the payload — refuses outright
  /// rather than guessing if either is missing, since that only happens
  /// for a line that was never actually read from Business Central (e.g.
  /// demo-seeded data reaching this adapter by mistake), and there is no
  /// way to address a Business Central line without its real id.
  async confirmPutAwayItem(payload) {
    const { bcPutAwayId, bcLineId, location, qty } = payload || {};
    if (!bcPutAwayId || !bcLineId) {
      throw ApiError.badRequest(
        'confirmPutAwayItem requires bcPutAwayId and bcLineId — this line was not read from Business Central, ' +
          'so there is no line to confirm against.',
      );
    }
    if (!location || qty == null) {
      throw ApiError.badRequest('confirmPutAwayItem requires location and qty.');
    }

    const updatedLine = await this._bcPatch(`putAways(${bcPutAwayId})/putAwayLines(${bcLineId})`, {
      binCode: location,
      qtyToHandle: qty,
    });

    return { ok: true, bcLine: updatedLine };
  }

  /// Maps onto Section 2.7, "Update Put-Away Lines — Batch Scan" — POST
  /// .../putAways(bcPutAwayId)/Microsoft.NAV.ProcessBatchScans. Replaces
  /// per-line PATCH calls (confirmPutAwayItem) as the confirm path going
  /// forward — one call per bin/document instead of one per line, per
  /// product decision (line-per-line was resource-intensive on Business
  /// Central and made the operator wait on N separate round trips).
  ///
  /// [entries] is [{ sku, bcLineId, location, qty }] — sku is unused by
  /// this adapter (BC addresses lines by bcLineId alone) but carried on
  /// every entry so demoDataSource.js's version of this method, which
  /// has no real bcLineId to address by, can still work from the same
  /// payload shape.
  /// confirmPutAwayItem already uses per-call, just batched. The doc is
  /// explicit that the SAME bcLineId can legitimately appear more than
  /// once (its own example does exactly this, for a bin-change mid-line);
  /// callers rely on that for serial-tracked lines, where every
  /// individually-scanned unit becomes its own entry with qtyToHandle: 1
  /// rather than one aggregated entry per line — see
  /// PutAwayItemController's batch-building logic for why. Entries are
  /// NOT deduplicated or merged here — sent exactly as given, in order,
  /// since order is significant (the doc's own example shows a later
  /// entry re-reading state left by an earlier one in the SAME call).
  ///
  /// scannedPayload is a JSON-encoded ARRAY passed as a STRING field, not
  /// a nested array — an awkward but explicit requirement in the doc
  /// (its own sample request body shows the backslash-escaped quotes).
  /// Getting this wrong (sending a real nested array) would fail
  /// silently or with a confusing "malformed" error rather than an
  /// obvious type mismatch, so this is deliberately built with
  /// JSON.stringify, not string concatenation.
  ///
  /// IMPORTANT — the doc is explicit that a failure here is ALL-OR-
  /// NOTHING: even a "Processed 2, skipped 1" message means the WHOLE
  /// call was rolled back, not that 2 entries succeeded. _bcPost already
  /// surfaces Business Central's raw response body on a non-OK response,
  /// which is exactly the aggregated "Entry N: <reason>" message needed
  /// to tell the operator which entry to fix — no special-casing needed
  /// here beyond letting that error propagate.
  async confirmPutAwayBatch(payload) {
    const { bcPutAwayId, entries } = payload || {};
    if (!bcPutAwayId) {
      throw ApiError.badRequest(
        'confirmPutAwayBatch requires bcPutAwayId — this document was not read from Business Central, ' +
          'so there is no put-away to confirm against.',
      );
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw ApiError.badRequest('confirmPutAwayBatch requires at least one entry.');
    }
    // Field names deliberately match confirmPutAwayItem's own payload
    // (location/qty), not Business Central's wire names (binCode/
    // qtyToHandle) — the mapping to BC's names happens below, at the
    // point of building scanEntries. Keeps one consistent entry shape
    // across both confirm paths and across data sources (demoDataSource
    // .js's version of this method addresses entries by sku instead of
    // bcLineId, since demo data has no real BC line GUIDs — sku is
    // carried on every entry for exactly that reason, even though this
    // adapter itself only needs bcLineId/location/qty).
    for (const [i, entry] of entries.entries()) {
      if (!entry.bcLineId || !entry.location || entry.qty == null) {
        throw ApiError.badRequest(
          `confirmPutAwayBatch entry ${i}: bcLineId, location, and qty are all required.`,
        );
      }
    }

    // IDEMPOTENT PUSH. The API adds every scan to whatever Qty. to Handle
    // is already on the line (Sections 2.6/2.7), so sending a quantity
    // Business Central already holds — an earlier confirm that was never
    // registered, a retry after a lost response, a bin confirmed twice —
    // is rejected as "Total handled quantity (2) exceeds the outstanding
    // quantity (1)" (WHPA-000176). Read what is actually there first and
    // send only the difference.
    const { toSend, held } = await this._reconcileBatchAgainstBc(bcPutAwayId, entries);
    if (held.length > 0) {
      logger.info(
        { bcPutAwayId, held: held.map((e) => e.bcLineId), sending: toSend.length },
        'Batch confirm: Business Central already holds these lines — not sending them again',
      );
    }
    if (toSend.length > 0) {
      const scanEntries = toSend.map((e) => ({ id: e.bcLineId, binCode: e.location, qtyToHandle: e.qty }));
      await this._bcPost(`putAways(${bcPutAwayId})/Microsoft.NAV.ProcessBatchScans`, {
        scannedPayload: JSON.stringify(scanEntries),
      });
    }

    // Saves only — never registers (see the note at the top of this file).
    // registerAttempted/registered/registerError are still returned, always
    // "not attempted", so an older app build that reads them keeps working.
    return { ok: true, held: held.length, registerAttempted: false, registered: false, registerError: null };
  }

  /// Compares each entry with what Business Central ALREADY has on that
  /// line and decides what, if anything, still needs sending. One fresh
  /// read of the document, then per entry (Place line, same bin or none):
  ///   nothing pending on the line ............ send as is (the normal case)
  ///   pending == scanned ..................... already held — send nothing
  ///   pending <  scanned ..................... send only the difference
  ///   pending >  scanned ..................... CONFLICT — Business Central
  ///       holds more than was scanned (typically refilled after a Register);
  ///       sending anything would either overflow or, worse, let Register
  ///       post units nobody scanned
  ///   pending, but the line has no bin ....... CONFLICT — a bin cannot be
  ///       set without adding quantity (qtyToHandle must be > 0)
  /// An entry for a DIFFERENT bin than the line's current one is passed
  /// through untouched: that is Business Central's own split territory
  /// (Section 2.6) and is not this method's to second-guess.
  /// A conflict throws BEFORE anything is sent, so the batch stays
  /// all-or-nothing and the operator hears the real reason.
  async _reconcileBatchAgainstBc(bcPutAwayId, entries) {
    const data = await this._bcGet(`putAways(${bcPutAwayId})?$expand=putAwayLines`);
    const placeById = new Map(
      ((data && data.putAwayLines) || []).filter((l) => l.actionType === 'Place').map((l) => [l.id, l]),
    );
    const norm = (v) => String(v || '').trim().toUpperCase();
    const toSend = [];
    const held = [];
    for (const e of entries) {
      const line = placeById.get(e.bcLineId);
      const pending = line ? Number(line.qtyToHandle || 0) : 0;
      const lineBin = line ? norm(line.binCode) : '';
      const sameOrNoBin = lineBin === '' || lineBin === norm(e.location);
      if (!line || pending === 0 || !sameOrNoBin) {
        toSend.push(e);
        continue;
      }
      if (lineBin === '') {
        throw ApiError.badRequest(
          `Business Central already has ${pending} set to handle on line ${line.lineNo} but no bin on it, ` +
            `so bin ${e.location} cannot be set without adding to that quantity.`,
        );
      }
      if (pending === e.qty) {
        held.push(e);
      } else if (pending < e.qty) {
        toSend.push({ ...e, qty: e.qty - pending });
      } else {
        throw ApiError.badRequest(
          `Business Central already has ${pending} set to handle on line ${line.lineNo}, but only ${e.qty} was scanned.`,
        );
      }
    }
    return { toSend, held };
  }

  /// Maps onto Section 2.8, "Register Put-Away" — POST
  /// .../putAways(bcPutAwayId)/Microsoft.NAV.Register, empty body, empty
  /// 200 response. Business Central's own equivalent of pressing
  /// "Register". The ONLY place a put-away is registered: called when the
  /// operator taps Register in the app, which the app allows only once
  /// every line of the document has been saved to Business Central (see
  /// PutAwayRepository.registerDocumentAwaited). Split Bin no longer
  /// registers; confirmPutAwayBatch no longer registers.
  async registerPutAway(payload) {
    const { bcPutAwayId } = payload || {};
    if (!bcPutAwayId) {
      throw ApiError.badRequest(
        'registerPutAway requires bcPutAwayId — this document was not read from Business Central, ' +
          'so there is no put-away to register.',
      );
    }
    await this._bcPost(`putAways(${bcPutAwayId})/Microsoft.NAV.Register`, {});
    return { ok: true };
  }

  /// No dedicated "validate a bin" action exists in Business Central's
  /// own API — confirmed against the full KIMS-WM API doc, every section
  /// (2.1 through 2.8, Picks included). The only bin-related read is
  /// Section 2.2 (GET /Bins), raw metadata with no validation or
  /// recommendation semantics of its own. So this is necessarily custom
  /// logic built on top of that raw list, not a passthrough to BC.
  ///
  /// Scope deliberately kept honest: checks that binCode genuinely
  /// exists as a bin at this put-away's own location (same
  /// location-scoping reasoning as checkPutAwayBin, and for the same
  /// reason — a same-named bin in a DIFFERENT BC location must not read
  /// as valid here). Does NOT check capacity/remaining room for qty —
  /// BC's Bins endpoint has no numeric capacity field, only isEmpty, and
  /// unlike checkPutAwayBin's case (a line BC left fully unassigned) a
  /// split-remainder bin is explicitly allowed to already hold some of
  /// the same item (see put_away_models.dart's BinSuggestion.isTopUp) —
  /// so isEmpty isn't the right gate here either. The actual
  /// batch-confirm call remains the real authority on whether Business
  /// Central ultimately accepts the quantity.
  async validatePutAwayBin(payload) {
    const { docId, binCode, sku, qty } = payload || {};
    if (!docId || !binCode || !sku || qty == null) {
      throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
    }
    const doc = await this.getPutAwayDocument(docId);
    const bin = await this._fetchBinByCode(binCode, doc.locationCode);
    if (!bin) {
      return { accepted: false, reason: `Bin "${binCode}" is not recognized at this location.` };
    }
    return { accepted: true };
  }

  async suggestPutAwayBin() { return this._notImplemented('suggestPutAwayBin'); }

  // ------------------------------------------------------------------
  // Pick — KIMS-WM API doc v2, Sections 2.5 (GET picks), 2.9
  // (UpdateLineScan), 2.10 (ProcessBatchScans) and 2.11 (Register).
  //
  // How Pick differs from Put Away (and why this is not a copy of it):
  //   - Only TAKE lines are scanned (Section 2.9). Place lines are synced
  //     by Business Central itself on every Take scan (Section 2.9.5) —
  //     the app never touches them. So Take lines become the app's
  //     items; Place lines only supply the destination (staging) bin.
  //   - A pick scan is a bound ACTION (POST), not a PATCH, and must carry
  //     the scanned lot/serial when the line is lot/serial-tracked
  //     (Section 2.9.3) — Put Away needs only the line id.
  //   - Business Central validates that the scanned bin physically holds
  //     the exact item/variant/lot/serial (Section 2.9.4). The app's own
  //     bin choice is reported back verbatim when BC rejects it.
  //   - Every scan is an INCREMENT and is not de-duplicated by BC.
  //     Resending a scan that already succeeded double-counts.
  // ------------------------------------------------------------------

  /// Maps one Business Central pick (with expanded pickLines) onto the
  /// app's PickDocument shape (see dataSource.interface.js). Returns null
  /// for a pick with nothing left to take, so the list only shows work.
  _mapPick(bc) {
    const lines = bc.pickLines || [];
    const takeLines = lines.filter((l) => l.actionType === 'Take');
    const placeLines = lines.filter((l) => l.actionType === 'Place');
    const norm = (v) => String(v || '').trim();
    const trackingKey = (l) => [l.itemNo, norm(l.variantCode), norm(l.lotNo), norm(l.serialNo)].join('|');

    // Destination bin per item/variant/lot/serial — the same key Business
    // Central itself uses to pair a Take line with its Place line (2.9.5).
    const placeBinByKey = new Map();
    for (const p of placeLines) {
      if (norm(p.binCode)) placeBinByKey.set(trackingKey(p), p.binCode);
    }

    const items = takeLines
      .map((line) => {
        const outstanding =
          typeof line.qtyOutstanding === 'number' ? line.qtyOutstanding : Number(line.quantity || 0);
        return {
          sku: line.itemNo,
          description: line.itemDesc,
          // The operator's scan target: qtyOutstanding (what is still to be
          // scanned). quantity is what the document handles in total.
          qty: outstanding,
          // Bin to take FROM. Business Central suggests one; the operator
          // may take from another bin holding the same stock (BC moves or
          // splits the line accordingly, Section 2.9.2).
          location: norm(line.binCode) ? line.binCode : null,
          bcLineId: line.id,
          lineNo: line.lineNo,
          variantCode: line.variantCode || null,
          lotNo: line.lotNo || null,
          serialNo: line.serialNo || null,
          isLotTracked: line.isLotTracked === true,
          isSerialTracked: line.isSerialTracked === true,
          // Same serial-line rule as Put Away — see SERIAL_LINES_SCANNABLE
          // at the top of this file.
          scannable:
            line.isScannable !== false ||
            (SERIAL_LINES_SCANNABLE && line.isSerialTracked === true && !!norm(line.serialNo)),
          destinationBin: placeBinByKey.get(trackingKey(line)) || null,
          // Business Central's own quantity fields, under their Business
          // Central names, so an item in the middleware dump can be matched
          // to its line in the raw response:
          //   quantity       — what the document is to handle (line total)
          //   qtyOutstanding — what the operator is to scan (= qty above)
          //   qtyHandled     — already registered (live data; not in the doc)
          //   qtyToHandle    — currently set to handle; posted by Register
          // The app shows quantity and qtyOutstanding; scans count to qty.
          quantity: typeof line.quantity === 'number' ? line.quantity : null,
          qtyHandled: typeof line.qtyHandled === 'number' ? line.qtyHandled : null,
          qtyOutstanding: typeof line.qtyOutstanding === 'number' ? line.qtyOutstanding : null,
          qtyToHandle: typeof line.qtyToHandle === 'number' ? line.qtyToHandle : null,
        };
      })
      .filter((item) => item.qty > 0);

    if (items.length === 0) return null;

    const stagingBins = [...new Set(placeLines.map((p) => norm(p.binCode)).filter(Boolean))];

    return {
      docId: bc.no,
      // No shipment reference on the documented pick header — the pick
      // number is the closest stable identifier the operator recognises.
      shipmentRef: bc.no,
      dueDate: bc.assignmentDate || null,
      // The pick header has no status field and the lines have no
      // qtyHandled (unlike put-away lines), so "how far along" cannot be
      // read from Business Central reliably: the doc's own sample shows an
      // untouched line already carrying qtyToHandle == qtyOutstanding.
      // Progress therefore stays with the app's local scan state.
      status: 'assigned',
      isHighPriority: false,
      items,
      bcPickId: bc.id,
      locationCode: bc.locationCode,
      assignedUserId: bc.assignedUserId || null,
      stagingBins,
    };
  }

  async getPickDocuments() {
    const data = await this._bcGet('picks?$expand=pickLines');
    // Same diagnostic as getPutAwayDocuments: the exact, unmapped response,
    // then one summary line per pick as the app will see it. Info level so
    // it shows in the terminal while Pick is verified against live data.
    logger.info({ rawBcResponse: data }, 'Raw Business Central response — GET picks?$expand=pickLines');
    const documents = (data.value || []).map((p) => this._mapPick(p)).filter(Boolean);
    logger.info({ pickDocuments: documents }, `Pick documents sent to app: ${documents.length}`);
    return { documents };
  }

  async getPickDocument(docId) {
    if (!docId) throw ApiError.badRequest('docId is required.');
    const escaped = String(docId).replace(/'/g, "''");
    const data = await this._bcGet(`picks?$expand=pickLines&$filter=no eq '${escaped}'`);
    logger.info({ docId, rawBcResponse: data }, 'Raw Business Central response — GET picks (single document)');
    const match = (data.value || [])[0];
    if (!match) throw ApiError.notFound(`Pick document "${docId}" not found.`);
    const mapped = this._mapPick(match);
    if (!mapped) throw ApiError.notFound(`Pick document "${docId}" has nothing left to pick.`);
    logger.info({ pickDocument: mapped }, `Pick document sent to app: ${docId}`);
    return mapped;
  }

  /// Fresh read of one pick's lines, keyed by line id. Used to fill in
  /// tracking values a scan entry did not carry and to detect a resend.
  async _fetchPickLinesById(bcPickId) {
    const data = await this._bcGet(`picks(${bcPickId})?$expand=pickLines`);
    return new Map(((data && data.pickLines) || []).map((l) => [l.id, l]));
  }

  /// Builds Business Central's scan fields for one entry against its line,
  /// enforcing the doc's tracking rules up front (Section 2.9.3) so the
  /// operator hears a clear reason instead of a rolled-back batch.
  ///
  /// Lot/serial: the entry's own scanned value is used when present.
  /// When it is absent, the line's own lot/serial is used — the app has
  /// already matched the unit (a serial line is scanned BY its serial; a
  /// lot line is scanned by item barcode), and BC still rejects any bin
  /// that does not physically hold that exact lot/serial (Section 2.9.4).
  _buildPickScan(entry, line, index) {
    const label = index == null ? 'Pick scan' : `entries[${index}]`;
    if (!line) {
      throw ApiError.badRequest(`${label}: line ${entry.bcLineId} is not on this pick in Business Central.`);
    }
    if (line.actionType !== 'Take') {
      throw ApiError.badRequest(`${label}: line ${line.lineNo} is a Place line — only Take lines can be scanned.`);
    }
    const qty = Number(entry.qty);
    if (!Number.isInteger(qty) || qty < 1) {
      throw ApiError.badRequest(`${label}: qty must be a whole number of at least 1 (got ${entry.qty}).`);
    }
    const scan = { binCode: entry.location, qtyToHandle: qty };
    if (line.isSerialTracked === true) {
      if (qty !== 1) {
        throw ApiError.badRequest(
          `${label}: serial-tracked line ${line.lineNo} must be scanned one unit per entry (got ${qty}).`,
        );
      }
      const serial = entry.serialNo || line.serialNo;
      if (!serial) {
        throw ApiError.badRequest(`${label}: line ${line.lineNo} is serial-tracked but no serial number is known.`);
      }
      scan.serialNo = serial;
    }
    if (line.isLotTracked === true) {
      const lot = entry.lotNo || line.lotNo;
      if (!lot) {
        throw ApiError.badRequest(`${label}: line ${line.lineNo} is lot-tracked but no lot number is known.`);
      }
      scan.lotNo = lot;
    }
    return scan;
  }

  /// Section 2.9 — POST pickLines(bcLineId)/Microsoft.NAV.UpdateLineScan.
  /// One real-time scan. Payload: { bcPickId?, bcLineId, location, qty,
  /// lotNo?, serialNo? }. bcPickId is optional: when given, the line is
  /// read first so tracking rules are checked and missing lot/serial
  /// values are filled in; without it the values are sent as received.
  /// NOT de-duplicated by Business Central — the caller must never resend
  /// a scan that already returned success.
  async confirmPickItem(payload) {
    const { bcPickId, bcLineId, location, qty, lotNo, serialNo } = payload || {};
    if (!bcLineId) {
      throw ApiError.badRequest(
        'confirmPickItem requires bcLineId — this line was not read from Business Central, so there is no line to scan against.',
      );
    }
    if (!location || qty == null) {
      throw ApiError.badRequest('confirmPickItem requires location and qty.');
    }

    let body;
    if (bcPickId) {
      const lines = await this._fetchPickLinesById(bcPickId);
      const scan = this._buildPickScan({ bcLineId, location, qty, lotNo, serialNo }, lines.get(bcLineId));
      body = { binCode: scan.binCode, qtyToHandle: scan.qtyToHandle };
      if (scan.serialNo) body.scannedSerialNo = scan.serialNo;
      if (scan.lotNo) body.scannedLotNo = scan.lotNo;
    } else {
      body = { binCode: location, qtyToHandle: Number(qty) };
      if (serialNo) body.scannedSerialNo = serialNo;
      if (lotNo) body.scannedLotNo = lotNo;
    }

    logger.info({ bcLineId, body }, 'Pick scan → Business Central UpdateLineScan');
    const updatedLine = await this._bcPost(`pickLines(${bcLineId})/Microsoft.NAV.UpdateLineScan`, body);
    logger.info({ bcLineId, bcLine: updatedLine }, 'Pick scan accepted by Business Central');
    return { ok: true, bcLine: updatedLine };
  }

  /// Section 2.10 — POST picks(bcPickId)/Microsoft.NAV.ProcessBatchScans,
  /// then Section 2.11 Register. The app sends a pick's batch once the
  /// whole pick is done (architecture decision: batched per pick for BC
  /// server performance), so Register follows straight away.
  ///
  /// Payload: { docId, bcPickId, entries: [{ sku, bcLineId, location,
  /// qty, lotNo?, serialNo? }] }. Entries are sent in order and the same
  /// bcLineId may repeat — a bin change mid-line is BC's own split
  /// (Section 2.10.4), and serial lines arrive one unit per entry.
  ///
  /// RESEND PROTECTION. BC adds every scan to the line and never
  /// de-duplicates, so a batch replayed after a lost response would
  /// double-count. Before sending, a line whose entries all target the
  /// line's CURRENT bin, and whose total equals what BC already has set to
  /// handle on it, is treated as already held and not sent again. Every
  /// other entry is sent as given, and BC stays the authority on whether
  /// it is accepted ("exceeds line quantity" etc. come back verbatim).
  ///
  /// Register's outcome is REPORTED, never thrown: once the batch has
  /// succeeded the scans are saved in BC, and throwing would make the
  /// app's outbox resend them.
  async confirmPickBatch(payload) {
    const { bcPickId, entries } = payload || {};
    if (!bcPickId) {
      throw ApiError.badRequest(
        'confirmPickBatch requires bcPickId — this pick was not read from Business Central, so there is no pick to confirm against.',
      );
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw ApiError.badRequest('confirmPickBatch requires at least one entry.');
    }
    for (const [i, entry] of entries.entries()) {
      if (!entry.bcLineId || !entry.location || entry.qty == null) {
        throw ApiError.badRequest(`confirmPickBatch entry ${i}: bcLineId, location, and qty are all required.`);
      }
    }

    const lines = await this._fetchPickLinesById(bcPickId);
    const scans = entries.map((e, i) => ({ entry: e, scan: this._buildPickScan(e, lines.get(e.bcLineId), i) }));

    const norm = (v) => String(v || '').trim().toUpperCase();
    const byLine = new Map();
    for (const s of scans) {
      const group = byLine.get(s.entry.bcLineId) || [];
      group.push(s);
      byLine.set(s.entry.bcLineId, group);
    }
    const heldLineIds = new Set();
    for (const [lineId, group] of byLine) {
      const line = lines.get(lineId);
      const lineBin = norm(line.binCode);
      const pending = Number(line.qtyToHandle || 0);
      const total = group.reduce((sum, s) => sum + s.scan.qtyToHandle, 0);
      const allOnLineBin = lineBin !== '' && group.every((s) => norm(s.scan.binCode) === lineBin);
      if (allOnLineBin && pending > 0 && pending === total) heldLineIds.add(lineId);
    }

    const toSend = scans.filter((s) => !heldLineIds.has(s.entry.bcLineId));
    if (heldLineIds.size > 0) {
      logger.info(
        { bcPickId, held: [...heldLineIds], sending: toSend.length },
        'Pick batch: Business Central already holds these lines — not sending them again',
      );
    }
    if (toSend.length > 0) {
      const scanEntries = toSend.map(({ entry, scan }) => {
        const e = { id: entry.bcLineId, binCode: scan.binCode, qtyToHandle: scan.qtyToHandle };
        if (scan.serialNo) e.serialNo = scan.serialNo;
        if (scan.lotNo) e.lotNo = scan.lotNo;
        return e;
      });
      logger.info({ bcPickId, scanEntries }, `Pick batch → Business Central ProcessBatchScans (${scanEntries.length} entries)`);
      await this._bcPost(`picks(${bcPickId})/Microsoft.NAV.ProcessBatchScans`, {
        scannedPayload: JSON.stringify(scanEntries),
      });
      logger.info({ bcPickId }, 'Pick batch accepted by Business Central');
    }

    let registerOutcome;
    try {
      logger.info({ bcPickId }, 'Pick → Business Central Register');
      await this._bcPost(`picks(${bcPickId})/Microsoft.NAV.Register`, {});
      logger.info({ bcPickId }, 'Pick registered after batch confirm');
      registerOutcome = { registerAttempted: true, registered: true, registerError: null };
    } catch (error) {
      logger.warn({ bcPickId, err: error }, 'Pick register after batch confirm failed');
      registerOutcome = { registerAttempted: true, registered: false, registerError: error.message || String(error) };
    }

    return { ok: true, held: heldLineIds.size, ...registerOutcome };
  }

  /// Section 2.11 — POST picks(bcPickId)/Microsoft.NAV.Register, empty
  /// body. For a manual Register (e.g. retrying after confirmPickBatch
  /// reported registered: false). Partial registration is normal: BC posts
  /// what is set to handle and leaves the rest outstanding on the pick.
  async registerPick(payload) {
    const { bcPickId } = payload || {};
    if (!bcPickId) {
      throw ApiError.badRequest(
        'registerPick requires bcPickId — this pick was not read from Business Central, so there is no pick to register.',
      );
    }
    logger.info({ bcPickId }, 'Pick → Business Central Register (manual)');
    await this._bcPost(`picks(${bcPickId})/Microsoft.NAV.Register`, {});
    logger.info({ bcPickId }, 'Pick registered (manual)');
    return { ok: true };
  }

  /// Live check for the bin an operator scanned to TAKE a pick line from.
  /// Business Central leaves most pick Take lines without a bin, and its
  /// own scan rule is that the bin must physically hold the exact item /
  /// lot / serial (Section 2.9.4). This answers that question up front —
  /// before any scanning starts — from the bin's contents (Section 2.2.2,
  /// the same read Bin Inquiry uses), scoped to the pick's location.
  /// Payload: { binCode, sku, lotNo?, serialNo?, locationCode? }.
  /// Returns { available, reason?, availableQty? }. Business Central stays
  /// the final authority when the batch is sent; this only spares the
  /// operator scanning into a bin that cannot accept it.
  async checkPickBin(payload) {
    const { binCode, sku, lotNo, serialNo, locationCode } = payload || {};
    if (!binCode || !sku) throw ApiError.badRequest('binCode and sku are required.');
    const esc = (v) => String(v).trim().replace(/'/g, "''");
    let filter = `binCode eq '${esc(binCode)}'`;
    if (locationCode) filter += ` and locationCode eq '${esc(locationCode)}'`;
    const data = await this._bcGet(`Bins?$filter=${filter}&$expand=binContentLines($expand=palletAndLots)`);
    const bin = (data.value || [])[0];
    if (!bin) {
      return { available: false, reason: `Bin "${binCode}" is not recognized at this location.` };
    }

    const norm = (v) => String(v || '').trim().toUpperCase();
    const lines = (bin.binContentLines || []).filter((l) => norm(l.itemNo) === norm(sku));
    if (lines.length === 0) {
      return { available: false, reason: `Bin ${bin.binCode} holds no ${sku}.` };
    }

    let qty = 0;
    for (const line of lines) {
      const lots = line.palletAndLots || [];
      if ((lotNo || serialNo) && lots.length > 0) {
        for (const lot of lots) {
          if (lotNo && norm(lot.lotNo) !== norm(lotNo)) continue;
          if (serialNo && norm(lot.serialNo) !== norm(serialNo)) continue;
          qty += Number(lot.quantity || 0);
        }
      } else {
        qty += Number(line.quantity || 0);
      }
    }

    if (qty <= 0) {
      const what = [sku, lotNo ? `lot ${lotNo}` : null, serialNo ? `serial ${serialNo}` : null].filter(Boolean).join(' ');
      return { available: false, reason: `Bin ${bin.binCode} holds no stock of ${what}.` };
    }
    return { available: true, availableQty: qty };
  }

  async getUnverifiedPicks() { return this._notImplemented('getUnverifiedPicks'); }
  async getVerifyPick() { return this._notImplemented('getVerifyPick'); }
  async submitVerifyPack() { return this._notImplemented('submitVerifyPack'); }
  async confirmShipLoad() { return this._notImplemented('confirmShipLoad'); }
  async generateGatePass() { return this._notImplemented('generateGatePass'); }
  // ------------------------------------------------------------------
  // Item Inquiry — KIMS-WM API doc v2, Section 2.3.1
  // (GET itemInquiries?$filter=barcodeFilter eq '...' | itemNo eq '...').
  //
  // One call returns the item's whole stock position: one line per
  // location / zone / bin / variant / lot / serial, quantities already
  // totalled, zero and negative lines left out by Business Central. Every
  // line belongs to the same item. A barcode tied to a variant returns
  // only that variant's stock.
  //
  // What the operator types or scans is tried in this order:
  //   1. as a barcode (barcodeFilter) — the normal case, a label scan;
  //   2. as an item number (itemNo) — typed or scanned item codes;
  //   3. as part of an item NAME, against the Section 2.3 catalog — the
  //      screen offers "search by name". itemInquiries itself cannot
  //      search by name, so a single matching item is then looked up by
  //      its number; several matches come back as a clear message asking
  //      for the barcode or number instead of silently picking one.
  // Business Central answers an unknown barcode / item with an error
  // ("Barcode X could not be found." / "Item X could not be found."); that
  // is treated as "no match, try the next way", never as a failure.
  // ------------------------------------------------------------------

  /// Stock lines for one barcode or item number, or null when Business
  /// Central says it could not be found. The filter is URL-encoded, as
  /// the doc asks (spaces as %20, quotes as %27), so a barcode containing
  /// &, #, a quote or a space cannot break the query.
  async _fetchItemInquiry(field, value) {
    const escaped = String(value).replace(/'/g, "''");
    const expr = encodeURIComponent(`${field} eq '${escaped}'`).replace(/'/g, '%27');
    const path = `itemInquiries?$filter=${expr}`;
    try {
      const data = await this._bcGet(path);
      logger.debug({ field, value, rawBcResponse: data }, 'Raw Business Central response — GET itemInquiries');
      return data.value || [];
    } catch (error) {
      if (/could not be found/i.test(error.message || '')) return null;
      throw error;
    }
  }

  /// Section 2.3 (GET items) catalog, cached for ITEM_CATALOG_TTL_MS.
  /// Used for the name search and for the item's UoM / tracking flags,
  /// which itemInquiries does not return. Item master data changes
  /// rarely; re-downloading the whole catalog on every scan would be the
  /// slowest part of each inquiry. A failed refresh keeps serving the
  /// previous copy if there is one, or an empty list — an inquiry never
  /// fails because of it.
  async _getItemCatalog() {
    const now = Date.now();
    if (this._itemCatalog && now - this._itemCatalog.fetchedAt < ITEM_CATALOG_TTL_MS) {
      return this._itemCatalog.items;
    }
    try {
      const data = await this._bcGet('items');
      this._itemCatalog = { items: data.value || [], fetchedAt: now };
    } catch (error) {
      logger.warn({ err: error }, 'Item catalog (GET items) unavailable — continuing without it');
      if (!this._itemCatalog) return [];
    }
    return this._itemCatalog.items;
  }

  /// Item Inquiry's lookup. [query] is whatever was scanned or typed.
  /// [locationCode] (the operator's own, from the JWT) limits the stock
  /// lines to that location, the same scoping Bin Inquiry and Put Away
  /// use; without one, every location is shown.
  async searchItem(query, { locationCode } = {}) {
    const q = String(query || '').trim();
    if (!q) throw ApiError.badRequest('Scan an item barcode or enter an item number or name.');

    let matchedBy = 'barcode';
    let lines = await this._fetchItemInquiry('barcodeFilter', q);

    if (lines === null || lines.length === 0) {
      // Item numbers are Business Central Code fields, stored upper-case.
      const byNumber = await this._fetchItemInquiry('itemNo', q.toUpperCase());
      if (byNumber !== null) {
        matchedBy = 'itemNo';
        lines = byNumber;
      }
    }

    const catalog = await this._getItemCatalog();
    let catalogItem = null;

    if (lines === null) {
      const needle = q.toLowerCase();
      const byName = needle.length >= 3
        ? catalog.filter((i) => String(i.item_name || '').toLowerCase().includes(needle))
        : [];
      if (byName.length === 0) {
        throw ApiError.notFound(`No item matches "${q}" by barcode, item number or name.`);
      }
      if (byName.length > 1) {
        const shown = byName.slice(0, 5).map((i) => `${i.item_no} (${i.item_name})`).join(', ');
        const more = byName.length > 5 ? ` and ${byName.length - 5} more` : '';
        throw ApiError.badRequest(
          `${byName.length} items match "${q}": ${shown}${more}. Scan the barcode or enter the item number.`,
        );
      }
      catalogItem = byName[0];
      matchedBy = 'name';
      lines = (await this._fetchItemInquiry('itemNo', catalogItem.item_no)) || [];
    }

    const itemNo = (lines[0] && lines[0].itemNo) || (catalogItem && catalogItem.item_no) || q.toUpperCase();
    catalogItem = catalogItem || catalog.find((i) => i.item_no === itemNo) || null;

    return this._mapItemInquiry({ query: q, matchedBy, itemNo, lines, catalogItem, locationCode });
  }

  /// Maps Section 2.3.1's stock lines onto the app's ItemInquiryResult.
  /// Keeps the fields the app already reads (sku, name, and per line:
  /// zone, location, bin, qty, batch) and adds Business Central's own
  /// detail. receivedDate / receivedBy (demo data only) are NOT sent:
  /// itemInquiries has no receipt date or user, and a made-up value would
  /// mislead the operator.
  _mapItemInquiry({ query, matchedBy, itemNo, lines, catalogItem, locationCode }) {
    const norm = (v) => String(v || '').trim();
    const scoped = locationCode
      ? lines.filter((l) => norm(l.locationCode).toUpperCase() === norm(locationCode).toUpperCase())
      : lines;

    const stockLines = scoped
      .map((l) => ({
        zone: norm(l.zoneCode),
        location: norm(l.locationCode),
        bin: norm(l.binCode),
        qty: toNumber(l.quantity),
        // The app's single "batch" column: lot, else serial.
        batch: norm(l.lotNo) || norm(l.serialNo),
        lotNo: norm(l.lotNo),
        serialNo: norm(l.serialNo),
        palletNo: norm(l.palletNo),
        variantCode: norm(l.variantCode),
      }))
      .sort((a, b) =>
        [a.location, a.zone, a.bin, a.lotNo, a.serialNo].join('|').localeCompare(
          [b.location, b.zone, b.bin, b.lotNo, b.serialNo].join('|'),
        ));

    const variants = [...new Set(lines.map((l) => norm(l.variantCode)))];
    const first = lines[0] || {};

    const result = {
      sku: itemNo,
      name: norm(first.itemDescription) || (catalogItem && catalogItem.item_name) || itemNo,
      stockLines,
      matchedBy, // 'barcode' | 'itemNo' | 'name'
      query,
      // Set when the barcode is tied to one variant (Section 2.3.1:
      // results are limited to that variant).
      variantCode: matchedBy === 'barcode' && variants.length === 1 && variants[0] ? variants[0] : null,
      locationCode: locationCode || null,
      summary: {
        totalQty: stockLines.reduce((sum, l) => sum + l.qty, 0),
        lineCount: stockLines.length,
        binCount: new Set(stockLines.filter((l) => l.bin).map((l) => `${l.location}|${l.bin}`)).size,
        lotCount: new Set(stockLines.filter((l) => l.lotNo).map((l) => l.lotNo)).size,
        locationCount: new Set(stockLines.map((l) => l.location)).size,
      },
      lastSyncedAt: new Date().toISOString(),
    };

    if (catalogItem) {
      result.uom = catalogItem.UoM || null;
      result.hasVariants = catalogItem.has_variants === true;
      result.hasBatches = catalogItem.has_batches === true;
      result.hasSerials = catalogItem.has_serials === true;
    }
    return result;
  }

  /// Maps onto Section 2.2, GET /Bins, filtered to one bin code.
  ///
  /// IMPORTANT — this is a DELIBERATELY partial mapping, not a full
  /// bin-inquiry implementation. GET /Bins gives real metadata (location,
  /// zone, type, description, barcode, and whether the bin is empty) but
  /// NEVER a list of what's actually sitting in it — no documented
  /// Business Central endpoint exposes bin contents (sku + qty per bin)
  /// at all. Rather than silently return items: [] and let that look
  /// identical to "this bin is genuinely empty," [contentsAvailable]:
  /// false is included specifically so a caller can distinguish "we
  /// don't have this data" from "the bin has nothing in it" — the demo
  /// adapter's items array (with real sku/batch/units) has no Business
  /// Central equivalent to source it from.
  ///
  /// Shared by searchBin and checkPutAwayBin below — both need "find the
  /// one bin matching this code," they just react differently when
  /// nothing matches (searchBin throws notFound; checkPutAwayBin returns
  /// a soft { available: false }). Returns the raw Business Central bin
  /// object, or null if nothing matched.
  ///
  /// [locationCode] is OPTIONAL and scopes the match to that location
  /// when given — searchBin (a general lookup by code, no location
  /// context) doesn't pass one; checkPutAwayBin (gating a specific
  /// document/line's bin assignment) does, and MUST: GET
  /// /Bins?$filter=binCode eq 'X' alone can match a same-named bin in a
  /// completely different BC location, which would come back "found" and
  /// "available" here but then fail Business Central's own PATCH .../
  /// putAwayLines validation (Internal_InvalidTableRelation) once
  /// confirmed, since that call validates the bin against the LINE's
  /// real location, not just the code in isolation.
  async _fetchBinByCode(binCode, locationCode) {
    const escapedBin = String(binCode || '').trim().replace(/'/g, "''");
    let filter = `binCode eq '${escapedBin}'`;
    if (locationCode) {
      const escapedLoc = String(locationCode).trim().replace(/'/g, "''");
      filter += ` and locationCode eq '${escapedLoc}'`;
    }
    const data = await this._bcGet(`Bins?$filter=${filter}`);
    return (data.value || [])[0] || null;
  }

  /// Bin Inquiry's single-bin lookup — Section 2.2.2 (bin metadata +
  /// binContentLines + palletAndLots in one call), filtered as the doc's
  /// "Filtering by Bin Code" describes.
  ///
  /// [code] is whatever the scanner read: a bin code OR a bin's barcode
  /// label (binBarCode — e.g. "MN-002927-03EN-P" for bin "A"). The bin code
  /// is tried first; if nothing matches, the barcode is tried.
  ///
  /// [locationCode] (the operator's own location, from inquiry.controller)
  /// scopes the match. Bin codes repeat across locations ("A" exists in
  /// several), and without this the FIRST same-coded bin anywhere came
  /// back — often another location's — which the controller's
  /// assertVisible then rejected as "not recognized" even though the bin
  /// exists right here. That was the main reason Bin Inquiry failed.
  ///
  /// Response: the shape the app's BinDetail.fromJson reads first
  /// (locationCode, matchedBy, binBarCode, crossDockBin, and `contents` —
  /// one entry per content line with its lots nested), PLUS the legacy
  /// fields (location, items, contentsAvailable, isActive) unchanged, so
  /// any older reader keeps working.
  async searchBin(code, { locationCode } = {}) {
    const value = String(code || '').trim();
    if (!value) throw ApiError.badRequest('binCode is required.');

    const esc = (v) => String(v).trim().replace(/'/g, "''");
    const locFilter = locationCode ? ` and locationCode eq '${esc(locationCode)}'` : '';
    const expand = '$expand=binContentLines($expand=palletAndLots)';
    // $filter after $expand, as the doc's "Filtering by Bin Code" shows.
    const find = async (field, v) => {
      const data = await this._bcGet(`Bins?${expand}&$filter=${field} eq '${esc(v)}'${locFilter}`);
      return (data.value || [])[0] || null;
    };

    let matchedBy = 'binCode';
    // Bin codes are Business Central Code fields — stored upper-case — so a
    // label scanned or typed in lower case still matches.
    let bin = await find('binCode', value.toUpperCase());
    if (!bin) {
      bin = await find('binBarCode', value);
      matchedBy = 'binBarCode';
    }
    if (!bin) {
      throw ApiError.notFound(
        locationCode ? `Bin "${value}" not found for location ${locationCode}.` : `Bin "${value}" is not recognized.`,
        'BIN_NOT_FOUND',
      );
    }

    const lines = bin.binContentLines || [];
    // Item names only matter when there is something in the bin; a failed
    // name lookup never fails the bin lookup (the item number is shown).
    let itemNames = new Map();
    if (lines.length > 0) {
      try {
        itemNames = await this._fetchItemNameLookup();
      } catch (error) {
        logger.warn({ err: error.message }, 'Bin Inquiry: item names unavailable — showing item numbers');
      }
    }

    const contents = lines.map((line) => {
      const quantity = Number(line.quantity) || 0;
      const pickQty = Number(line.pickQty) || 0;
      return {
        itemNo: line.itemNo,
        itemName: itemNames.get(line.itemNo) || line.itemNo,
        variantCode: line.variantCode || '',
        unitOfMeasureCode: line.unitOfMeasureCode || '',
        quantity,
        pickQty,
        putAwayQty: Number(line.putAwayQty) || 0,
        availableQty: Math.max(0, quantity - pickQty),
        lots: (line.palletAndLots || []).map((lot) => ({
          lotNo: lot.lotNo || '',
          serialNo: lot.serialNo || '',
          packageNo: lot.packageNo || '',
          // Note the lower-case "o" in Business Central's field name.
          unitOfMeasureCode: lot.unitofMeasureCode || lot.unitOfMeasureCode || '',
          quantity: Number(lot.quantity) || 0,
        })),
      };
    });

    return {
      binCode: bin.binCode,
      locationCode: bin.locationCode,
      matchedBy, // 'binCode' | 'binBarCode'
      binDescription: bin.binDescription,
      binTypeCode: bin.binTypeCode,
      zoneCode: bin.zoneCode,
      binBarCode: bin.binBarCode,
      isEmpty: bin.isEmpty,
      crossDockBin: bin.crossDockBin === true,
      contents,
      lastSyncedAt: new Date().toISOString(),
      // Legacy fields, kept so nothing reading the older shape breaks.
      location: bin.locationCode,
      isActive: true,
      items: this._legacyItemsFromContents(contents),
      contentsAvailable: true,
    };
  }

  /// The older flat shape ({ name, sku, batch, units }, one row per lot)
  /// built from `contents`, for readers that still use `items`.
  _legacyItemsFromContents(contents) {
    const items = [];
    for (const line of contents) {
      if (line.lots.length === 0) {
        items.push({ name: line.itemName, sku: line.itemNo, batch: '', units: line.quantity });
        continue;
      }
      for (const lot of line.lots) {
        items.push({ name: line.itemName, sku: line.itemNo, batch: lot.lotNo || lot.serialNo || lot.packageNo || '', units: lot.quantity });
      }
    }
    return items;
  }

  /// Section 2.3 (GET /items) has no documented single-item lookup, so the
  /// catalogue is read whole and turned into an itemNo -> item_name map.
  /// It used to be read on EVERY bin lookup, which on a large catalogue
  /// made Bin Inquiry slow enough to time out on the device. Item names
  /// rarely change, so the map is now kept for [_itemNameTtlMs]; a failed
  /// refresh keeps using the last good map when there is one.
  async _fetchItemNameLookup() {
    const now = Date.now();
    if (this._itemNameCache && now - this._itemNameCache.at < BusinessCentralDataSource._itemNameTtlMs) {
      return this._itemNameCache.map;
    }
    try {
      const data = await this._bcGet('items');
      const lookup = new Map();
      for (const item of data.value || []) {
        if (item.item_no) lookup.set(item.item_no, item.item_name);
      }
      this._itemNameCache = { map: lookup, at: now };
      return lookup;
    } catch (error) {
      if (this._itemNameCache) return this._itemNameCache.map;
      throw error;
    }
  }

  /// Section 2.2 has no endpoint dedicated to "is this bin available for
  /// a specific sku" — this reuses the EXACT same GET /Bins?$filter
  /// lookup searchBin uses above (via _fetchBinByCode), since that's the
  /// only real capability Business Central actually exposes here. This
  /// is a genuine, if reduced, capability — NOT the same behavior as
  /// demoDataSource.js's version: demo's in-memory registry tracks
  /// occupantSku, so it can distinguish "empty," "occupied by the SAME
  /// sku" (accepted — a legitimate top-up), and "occupied by a
  /// DIFFERENT sku" (rejected). Real Business Central /Bins exposes
  /// isEmpty as a boolean only — never what's actually occupying a
  /// non-empty bin — so sku is accepted here for signature parity with
  /// the demo adapter but genuinely unused: this can only ever answer
  /// "empty" (accepted) or "not empty" (rejected, without being able to
  /// say by what). An honest reduction of what the mocked version could
  /// do, not a bug — see this class's own doc for why validatePutAwayBin/
  /// suggestPutAwayBin have the identical gap for the same reason.
  ///
  /// [locationCode], when given, is passed straight to _fetchBinByCode —
  /// see that method's doc for why this one, unlike searchBin, genuinely
  /// needs it: a bin code that exists in a different BC location must be
  /// treated as NOT FOUND here, not "found and available," since it
  /// isn't valid for the document/line this check is actually gating.
  /// Per direct instruction: a non-empty bin is no longer rejected here.
  /// Business Central itself does not enforce "the bin must be empty" —
  /// the earlier isEmpty rejection was this middleware's own, overly
  /// conservative assumption, not something BC actually requires. Real
  /// BC's /Bins endpoint only ever exposes isEmpty as a bare boolean
  /// (see this method's own earlier doc above), so unlike
  /// demoDataSource.js's richer occupantSku-based check (same-sku
  /// top-up allowed, different-sku rejected), there is no way to tell
  /// here WHAT occupies a non-empty bin — so this no longer tries to
  /// gate on it at all. A recognized bin is now always available;
  /// "not recognized" (the bin code doesn't exist, or exists in a
  /// different BC location) is still the only rejection.
  async checkPutAwayBin(payload) {
    const { binCode, locationCode } = payload || {};
    if (!binCode) throw ApiError.badRequest('binCode is required.');
    const bin = await this._fetchBinByCode(binCode, locationCode);

    if (!bin) {
      return { available: false, reason: `Bin "${binCode}" is not recognized.` };
    }
    return { available: true };
  }

  /// Lists every bin from Section 2.2 (GET /Bins), unfiltered — the
  /// "browse all bins" view, distinct from searchBin above which filters
  /// to one binCode. Same field shape as demoDataSource.js's listBins
  /// where both sources can support it (binCode, isEmpty); Business
  /// Central additionally provides real metadata demo never had
  /// (binDescription, locationCode, zoneCode, binTypeCode, binBarCode).
  /// capacity/currentQty/occupantSku are demo-only concepts — the /Bins
  /// endpoint has no capacity or contents field at all (see
  /// businessCentralDataSource.js's searchBin doc for the same gap on
  /// the single-bin lookup) — so they're simply absent here rather than
  /// guessed at.
  /// [locationCode], when given, is applied server-side via OData
  /// $filter (same pattern already proven by searchBin's binCode
  /// filter) — meaningful for a warehouse with more than one BC
  /// location, where fetching every bin everywhere just to look at one
  /// location's would be wasteful. isEmpty is deliberately NOT filtered
  /// here — that's left to the Flutter side to apply client-side over
  /// whichever bins this call already returned, so toggling it doesn't
  /// cost a network round trip.
  async listBins(locationCode) {
    const path = locationCode
      ? `Bins?$filter=locationCode eq '${String(locationCode).replace(/'/g, "''")}'`
      : 'Bins';
    const data = await this._bcGet(path);
    return {
      bins: (data.value || []).map((bin) => ({
        binCode: bin.binCode,
        isEmpty: bin.isEmpty,
        binDescription: bin.binDescription,
        locationCode: bin.locationCode,
        zoneCode: bin.zoneCode,
        binTypeCode: bin.binTypeCode,
        binBarCode: bin.binBarCode,
      })),
    };
  }

  async trackPallet() { return this._notImplemented('trackPallet'); }

  // Item Transfer — document-driven: expected to map onto Business
  // Central's warehouse internal movement journal (or item journal,
  // depending on how Klan's BC environment is configured), where the
  // document itself (which bins, which skus, which quantities) comes from
  // a BC-side transfer/movement request that's already been approved
  // before it reaches this adapter — the operator executes it, never
  // decides it.
  async getTransferDocuments() { return this._notImplemented('getTransferDocuments'); }
  async getTransferDocument() { return this._notImplemented('getTransferDocument'); }
  async validateTransferSplitBin() { return this._notImplemented('validateTransferSplitBin'); }
  async suggestTransferSplitBin() { return this._notImplemented('suggestTransferSplitBin'); }
  async confirmTransferItem() { return this._notImplemented('confirmTransferItem'); }

  // Quarantine — document-driven, same BC movement mechanism as Item
  // Transfer, plus whatever field BC uses to record a quarantine reason
  // on the line.
  async getQuarantineDocuments() { return this._notImplemented('getQuarantineDocuments'); }
  async getQuarantineDocument() { return this._notImplemented('getQuarantineDocument'); }
  async validateQuarantineSplitBin() { return this._notImplemented('validateQuarantineSplitBin'); }
  async suggestQuarantineSplitBin() { return this._notImplemented('suggestQuarantineSplitBin'); }
  async confirmQuarantineItem() { return this._notImplemented('confirmQuarantineItem'); }
}

/// How long the item-name map is reused (see _fetchItemNameLookup).
BusinessCentralDataSource._itemNameTtlMs = 10 * 60 * 1000;

module.exports = BusinessCentralDataSource;