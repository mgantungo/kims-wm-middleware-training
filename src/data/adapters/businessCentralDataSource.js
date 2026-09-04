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
 *     inquiries) and maps the response into the same JSON shape the demo
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
}

module.exports = BusinessCentralDataSource;