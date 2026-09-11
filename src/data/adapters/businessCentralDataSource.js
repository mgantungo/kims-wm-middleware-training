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
    }));

    // ASSUMPTION: the putAways endpoint has no status field at all, and
    // there is no write-back endpoint to make a real confirm the source
    // of truth for it (see class doc). Inferred here as a proxy from
    // qtyToHandle vs quantity across the Place lines. Revisit once/if a
    // real confirm endpoint exists — at that point local outbox state
    // should probably take over as the source of truth instead.
    const allUntouched = placeLines.every((l) => l.qtyToHandle == null || l.qtyToHandle === l.quantity);
    const allDone = placeLines.length > 0 && placeLines.every((l) => (l.qtyToHandle ?? l.quantity) === 0);
    const status = allDone ? 'complete' : allUntouched ? 'assigned' : 'inProgress';

    return {
      docId: bc.no,
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

  async confirmPutAwayItem() { return this._notImplemented('confirmPutAwayItem'); }
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
  async searchBin() { return this._notImplemented('searchBin'); }
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