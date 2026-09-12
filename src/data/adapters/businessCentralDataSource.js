// src/data/adapters/businessCentralDataSource.js
const ApiError = require('../../utils/apiError');

/**
 * Implements the exact same method surface as DemoDataSource (see
 * dataSource.interface.js) so that flipping DATA_SOURCE=businessCentral in
 * .env is the *only* change needed to switch — no route or controller code
 * changes.
 *
 * CURRENT SCOPE (per product decision, 2026-09): only the Put Away READ
 * path is implemented against real Business Central data —
 * getPutAwayDocuments/getPutAwayDocument. Every other method, including
 * confirmPutAwayItem/validatePutAwayBin/suggestPutAwayBin/checkPutAwayBin,
 * is still `_notImplemented()`. This isn't an oversight: the KIMS-WM API
 * Endpoint Reference doc (v1, 2026-09-07) only documents GET endpoints —
 * there is no write-back endpoint for confirming a put-away, and no
 * capacity field on the Bins endpoint for a real validate/suggest. Those
 * stay mocked (DATA_SOURCE=demo) until a write-capable endpoint is
 * documented — deliberately NOT downgraded to a weaker "best effort"
 * implementation against data that can't actually support them.
 *
 * Auth is HTTP Basic (username + Business Central Web Service Access Key),
 * not OAuth2 — see _bcGet below.
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
      // Business Central's documented business-logic errors for this
      // endpoint (exceeding line quantity, an invalid mid-line bin
      // change) come back as this same non-2xx shape — surfaced as-is
      // rather than guessed at, so whoever reads the middleware log sees
      // BC's own error text, not a generic wrapper around it.
      throw ApiError.internal(
        `Business Central rejected the put-away line update (${response.status}) for ${pathAndQuery}` +
          `${responseBody ? `: ${responseBody}` : ''}`,
        'BC_CONFIRM_REJECTED',
      );
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
      throw ApiError.internal(
        `Business Central rejected the action call (${response.status}) for ${pathAndQuery}` +
          `${responseBody ? `: ${responseBody}` : ''}`,
        'BC_ACTION_REJECTED',
      );
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

    const items = placeLines.map((line) => ({
      sku: line.itemNo,
      description: line.itemDesc,
      qty: line.quantity,
      // A blank binCode on a Place line is exactly what
      // PutAwayLineItem.location == null already means — Business
      // Central did not pre-assign a destination, operator chooses one
      // on the floor. Mapping it straight to null is what makes that
      // existing flow apply to real BC data with no extra logic.
      location: line.binCode && line.binCode.trim() ? line.binCode : null,
      // ASSUMPTION: the API doc has no equivalent of this app-level
      // flag. Defaults to true (scan-based counting) for every line
      // until/unless Business Central exposes something to derive it
      // from — e.g. the items endpoint's has_serials/has_batches could
      // be a signal for a future pass, but isn't wired up here since
      // that would mean a second BC call per line.
      scannable: true,
      // Business Central's own line GUID — required to address PATCH
      // .../putAwayLines(bcLineId) when this line is confirmed (Section
      // 2.5). The app carries this through untouched even across a
      // LOCAL split (see PutAwayLineItem.splitShort) — both the settled
      // and remainder halves target this same original line id, which
      // is exactly what triggers Business Central's OWN server-side
      // split when the second PATCH arrives with a different bin.
      bcLineId: line.id,
    }));

    // ASSUMPTION: the putAways endpoint itself has no status field.
    // Inferred here as a proxy from qtyToHandle vs quantity across the
    // Place lines — this is still just a read-time snapshot of BC's
    // state, not the app's own source of truth for an in-progress
    // document (the local outbox is). Now that confirmPutAwayItem
    // actually writes back (Section 2.5), a document's status here will
    // correctly reflect confirmed lines on the NEXT read, but isn't
    // updated by this adapter proactively.
    const allUntouched = placeLines.every((l) => l.qtyToHandle == null || l.qtyToHandle === l.quantity);
    const allDone = placeLines.length > 0 && placeLines.every((l) => (l.qtyToHandle ?? l.quantity) === 0);
    const status = allDone ? 'complete' : allUntouched ? 'assigned' : 'inProgress';

    return {
      docId: bc.no,
      // Business Central's own put-away header GUID — required to
      // address PATCH .../putAways(bcPutAwayId)/putAwayLines(...) for
      // every line on this document.
      bcPutAwayId: bc.id,
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

  /// Maps onto Section 2.6, "Register Put-Away" — POST
  /// .../putAways(bcPutAwayId)/Microsoft.NAV.Register, empty body, empty
  /// 200 response. Business Central's own equivalent of pressing
  /// "Register" once every line on the document has been handled — the
  /// app calls this exactly once per document, right after its last line
  /// is confirmed (see PutAwayItemController._refreshAfterConfirmation /
  /// PutAwayRepository.registerDocument).
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

  async validatePutAwayBin() { return this._notImplemented('validatePutAwayBin'); }
  async suggestPutAwayBin() { return this._notImplemented('suggestPutAwayBin'); }
  async checkPutAwayBin() { return this._notImplemented('checkPutAwayBin'); }
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
  /// Every field the demo adapter returns (binCode, location, isActive,
  /// items, lastSyncedAt) is still present here with the same meaning, so
  /// nothing currently reading those specific fields breaks — the extra
  /// fields below (binDescription, binTypeCode, zoneCode, isEmpty) are
  /// purely additive.
  async searchBin(binCode) {
    if (!binCode) throw ApiError.badRequest('binCode is required.');
    const escaped = String(binCode).replace(/'/g, "''");
    const data = await this._bcGet(`Bins?$filter=binCode eq '${escaped}'`);
    const bin = (data.value || [])[0];
    if (!bin) throw ApiError.notFound(`Bin "${binCode}" is not recognized.`);

    return {
      binCode: bin.binCode,
      location: bin.locationCode,
      isActive: true, // found in Business Central's own bin registry
      items: [],
      contentsAvailable: false,
      lastSyncedAt: new Date().toISOString(),
      // Additive — real Business Central metadata the demo shape never
      // had, ignored harmlessly by any caller that doesn't know about it.
      binDescription: bin.binDescription,
      binTypeCode: bin.binTypeCode,
      zoneCode: bin.zoneCode,
      isEmpty: bin.isEmpty,
    };
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