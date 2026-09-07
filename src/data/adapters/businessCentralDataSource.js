// src/data/adapters/businessCentralDataSource.js
const ApiError = require('../../utils/apiError');

/**
 * Phase 2 placeholder. Implements the exact same method surface as
 * DemoDataSource (see dataSource.interface.js) so that flipping
 * DATA_SOURCE=businessCentral in .env is the *only* change needed once
 * Business Central API credentials are issued — no route or controller
 * code changes.
 *
 * Expected implementation approach when the credentials land:
 *   - OAuth2 client-credentials flow against Azure AD (BC_TENANT_ID,
 *     BC_CLIENT_ID, BC_CLIENT_SECRET) to obtain a bearer token for the
 *     Business Central API.
 *   - Each method below calls the corresponding Business Central OData v4 /
 *     API v2.0 endpoint (e.g. warehouse activity lines for put-away/pick,
 *     sales shipment lines for gate pass, item ledger entries for
 *     inquiries, warehouse internal movement journal lines for Item
 *     Transfer) and maps the response into the same JSON shape the demo
 *     adapter already returns — that mapping is the actual Phase 2 work.
 *   - Token acquisition/caching belongs in its own bcAuthClient.js
 *     alongside this file, not inlined here.
 */
class BusinessCentralDataSource {
  constructor(config) {
    this.config = config;
  }

  _notImplemented(method) {
    throw ApiError.internal(
      `Business Central integration for "${method}" is not implemented yet. Set DATA_SOURCE=demo in .env until Phase 2.`,
      'BC_NOT_IMPLEMENTED',
    );
  }

  async getPutAwayDocuments() { return this._notImplemented('getPutAwayDocuments'); }
  async getPutAwayDocument() { return this._notImplemented('getPutAwayDocument'); }
  async confirmPutAwayItem() { return this._notImplemented('confirmPutAwayItem'); }
  async validatePutAwayBin() { return this._notImplemented('validatePutAwayBin'); }
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