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
 * can't answer compared to the mocked demo version).
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

    const scanEntries = entries.map((e) => ({ id: e.bcLineId, binCode: e.location, qtyToHandle: e.qty }));
    await this._bcPost(`putAways(${bcPutAwayId})/Microsoft.NAV.ProcessBatchScans`, {
      scannedPayload: JSON.stringify(scanEntries),
    });

    // Per product decision: every time a bin's batch is successfully
    // pushed to Business Central, the middleware attempts to register the
    // whole put-away right away if that batch happened to be the last
    // thing the document needed. Deliberately AWAITED, not fire-and-
    // forget — the operator needs to actually know whether it worked, not
    // just have it happen silently in the background. The batch confirm
    // itself already succeeded by this point regardless of what happens
    // next, so a register outcome (attempted, succeeded, or failed) is
    // reported alongside it rather than thrown — a failed or skipped
    // register must never make the app think the bin confirm itself
    // failed, which would risk it being retried unnecessarily.
    const registerOutcome = await this._tryAutoRegister(bcPutAwayId);

    return { ok: true, ...registerOutcome };
  }

  /// Re-reads the document fresh (not the batch-confirm response, which
  /// carries no line detail) and reuses _mapPutAway's own status
  /// computation — the same allDone/qtyToHandle criterion that already
  /// decides "complete" everywhere else — so this can never drift from
  /// what the rest of the app considers done. Returns a plain result
  /// object rather than throwing on failure, since a failed or
  /// not-applicable register here is information for the caller to
  /// report, not an error in confirmPutAwayBatch's own contract.
  async _tryAutoRegister(bcPutAwayId) {
    const data = await this._bcGet(`putAways(${bcPutAwayId})?$expand=putAwayLines`);
    const mapped = this._mapPutAway(data);
    if (mapped.status !== 'complete') {
      return { registerAttempted: false, registered: false, registerError: null };
    }
    logger.info({ bcPutAwayId }, 'Document complete after batch confirm — attempting auto-register');
    try {
      await this._bcPost(`putAways(${bcPutAwayId})/Microsoft.NAV.Register`, {});
      logger.info({ bcPutAwayId }, 'Auto-register succeeded');
      return { registerAttempted: true, registered: true, registerError: null };
    } catch (error) {
      logger.warn({ bcPutAwayId, err: error }, 'Auto-register-on-complete-bin attempt failed');
      return { registerAttempted: true, registered: false, registerError: error.message || String(error) };
    }
  }

  /// Maps onto Section 2.8, "Register Put-Away" — POST
  /// .../putAways(bcPutAwayId)/Microsoft.NAV.Register, empty body, empty
  /// 200 response. Business Central's own equivalent of pressing
  /// "Register". Called by the app in two situations: (1) once, right
  /// after a document's last line is confirmed (see
  /// PutAwayItemController._refreshAfterConfirmation /
  /// PutAwayRepository.registerDocument), and (2) as a PARTIAL register,
  /// right after Split Bin pushes an item's scanned quantity (see
  /// PutAwayRepository.registerPartialNow) — Business Central registers
  /// what is currently set to handle and leaves the remainder
  /// outstanding, so a partial register is not an error in itself.
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
  async getPickDocuments() { return this._notImplemented('getPickDocuments'); }
  async getPickDocument() { return this._notImplemented('getPickDocument'); }
  async confirmPickItem() { return this._notImplemented('confirmPickItem'); }
  async getUnverifiedPicks() { return this._notImplemented('getUnverifiedPicks'); }
  async getVerifyPick() { return this._notImplemented('getVerifyPick'); }
  async submitVerifyPack() { return this._notImplemented('submitVerifyPack'); }
  async confirmShipLoad() { return this._notImplemented('confirmShipLoad'); }
  async generateGatePass() { return this._notImplemented('generateGatePass'); }
  async searchItem() { return this._notImplemented('searchItem'); }

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

  /// Every field the demo adapter returns (binCode, location, isActive,
  /// items, lastSyncedAt) is still present here with the same meaning, so
  /// nothing currently reading those specific fields breaks — the extra
  /// fields below (binDescription, binTypeCode, zoneCode, isEmpty) are
  /// purely additive. Deliberately NOT location-scoped (see
  /// _fetchBinByCode's doc) — this is a general "look this code up
  /// anywhere" inquiry, not a gate on a specific document's bin
  /// assignment, so a same-named bin existing in more than one location
  /// isn't a correctness problem here the way it is for checkPutAwayBin.
  ///
  /// items/contentsAvailable are now real — Section 2.2.1/2.2.2
  /// (binContentLines, optionally expanded with palletAndLots) is a
  /// genuinely new Business Central capability this adapter didn't have
  /// before. See _mapBinContentsToItems for the actual mapping.
  async searchBin(binCode) {
    if (!binCode) throw ApiError.badRequest('binCode is required.');
    const escapedBin = String(binCode).trim().replace(/'/g, "''");
    const data = await this._bcGet(`Bins?$filter=binCode eq '${escapedBin}'&$expand=binContentLines($expand=palletAndLots)`);
    const bin = (data.value || [])[0] || null;
    if (!bin) throw ApiError.notFound(`Bin "${binCode}" is not recognized.`);

    const items = await this._mapBinContentsToItems(bin.binContentLines || []);

    return {
      binCode: bin.binCode,
      location: bin.locationCode,
      isActive: true, // found in Business Central's own bin registry
      items,
      contentsAvailable: true,
      lastSyncedAt: new Date().toISOString(),
      // Additive — real Business Central metadata the demo shape never
      // had, ignored harmlessly by any caller that doesn't know about it.
      binDescription: bin.binDescription,
      binTypeCode: bin.binTypeCode,
      zoneCode: bin.zoneCode,
      isEmpty: bin.isEmpty,
    };
  }

  /// Maps Section 2.2.2's binContentLines (each optionally expanded with
  /// palletAndLots) into the app's BinItemLine shape ({name, sku, batch,
  /// units}) — per product decision, ONE ROW PER LOT when an item is
  /// lot/serial-tracked (a single content line can span several lots,
  /// and the operator needs each one's own quantity visible, not a
  /// merged total), or one row for the whole content line when it isn't
  /// tracked that way at all (no palletAndLots present — batch is then
  /// genuinely empty, not guessed at; the screen shows "—" for that
  /// case, see bin_inquiry_screen.dart's _ContentsTable).
  ///
  /// name is a REAL item description now, not itemNo repeated as both
  /// fields — binContentLines itself has no description field, only
  /// itemNo, so this cross-references Section 2.3 (GET /items) via
  /// _fetchItemNameLookup. Falls back to itemNo itself if a given
  /// itemNo genuinely isn't in that catalog (shouldn't happen against
  /// real data, but a bin content line existing for an item the items
  /// catalog doesn't know about is safer read as "show the code" than
  /// as a thrown error over a cosmetic gap).
  async _mapBinContentsToItems(binContentLines) {
    if (binContentLines.length === 0) return [];

    const itemNames = await this._fetchItemNameLookup();
    const items = [];

    for (const line of binContentLines) {
      const name = itemNames.get(line.itemNo) || line.itemNo;
      const lots = line.palletAndLots || [];

      if (lots.length === 0) {
        items.push({ name, sku: line.itemNo, batch: '', units: line.quantity ?? 0 });
        continue;
      }

      for (const lot of lots) {
        const batch = lot.lotNo || lot.serialNo || lot.packageNo || '';
        items.push({ name, sku: line.itemNo, batch, units: lot.quantity ?? 0 });
      }
    }

    return items;
  }

  /// Section 2.3 (GET /items) has no documented single-item lookup, and
  /// its snake_case/mixed-case field naming (item_no, item_name, UoM) —
  /// unlike the camelCase entities everywhere else in this adapter
  /// (binCode, itemNo, locationCode) — marks it as a different kind of
  /// API surface, not safe to assume standard OData $filter support on
  /// without that being documented. So this fetches the whole catalog
  /// once per searchBin call and builds an itemNo -> item_name lookup
  /// locally, rather than filtering per unique item in the bin. No
  /// caching — item names change rarely, but staying honest about
  /// current data beats risking a stale one; worth revisiting with a
  /// short-TTL cache if this proves slow against a large catalog.
  async _fetchItemNameLookup() {
    const data = await this._bcGet('items');
    const lookup = new Map();
    for (const item of data.value || []) {
      if (item.item_no) lookup.set(item.item_no, item.item_name);
    }
    return lookup;
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

module.exports = BusinessCentralDataSource;