// src/data/adapters/hybridDataSource.js
const demoDataSource = require('./demoDataSource');
const BusinessCentralDataSource = require('./businessCentralDataSource');

/**
 * Makes a genuinely phased rollout possible: one method (or a few) can be
 * routed to Business Central while every other method stays on demo data,
 * AT THE SAME TIME, in the same deployment — unlike DATA_SOURCE=
 * businessCentral directly, which switches the ENTIRE adapter at once and
 * breaks every module Business Central integration hasn't reached yet
 * (Transfer, Quarantine, Pick, etc. all throw BC_NOT_IMPLEMENTED the
 * moment that flag flips, even though only Put Away's read path has
 * actually been migrated).
 *
 * Each future phase is one change here: move a method's line from the
 * "always demo" section to the routed section, backed by its own env var
 * the same way PUT_AWAY_READ_SOURCE works below. Nothing else in the
 * codebase needs to change — routes/controllers only ever talk to
 * `dataSource` from dataSourceFactory.js, never a specific adapter.
 */
class HybridDataSource {
  constructor({ businessCentralConfig, putAwayReadSource }) {
    this._demo = demoDataSource;
    this._bc = new BusinessCentralDataSource(businessCentralConfig);
    this._putAwayReadSource = putAwayReadSource; // 'demo' | 'businessCentral'
  }

  _putAwayReadTarget() {
    return this._putAwayReadSource === 'businessCentral' ? this._bc : this._demo;
  }

  // ---------------- Put Away — read path is routable ----------------
  async getPutAwayDocuments(...args) {
    return this._putAwayReadTarget().getPutAwayDocuments(...args);
  }

  async getPutAwayDocument(...args) {
    return this._putAwayReadTarget().getPutAwayDocument(...args);
  }

  // Confirm/validate/suggest/check-bin have no Business Central
  // counterpart yet (see businessCentralDataSource.js's class doc) — no
  // routing to build for these until one exists. Always demo.
  async confirmPutAwayItem(...args) { return this._demo.confirmPutAwayItem(...args); }
  async validatePutAwayBin(...args) { return this._demo.validatePutAwayBin(...args); }
  async suggestPutAwayBin(...args) { return this._demo.suggestPutAwayBin(...args); }
  async checkPutAwayBin(...args) { return this._demo.checkPutAwayBin(...args); }

  // ---------------- Everything else — always demo until its own phase ----------------
  async getPickDocuments(...args) { return this._demo.getPickDocuments(...args); }
  async getPickDocument(...args) { return this._demo.getPickDocument(...args); }
  async confirmPickItem(...args) { return this._demo.confirmPickItem(...args); }
  async getUnverifiedPicks(...args) { return this._demo.getUnverifiedPicks(...args); }
  async getVerifyPick(...args) { return this._demo.getVerifyPick(...args); }
  async submitVerifyPack(...args) { return this._demo.submitVerifyPack(...args); }
  async confirmShipLoad(...args) { return this._demo.confirmShipLoad(...args); }
  async generateGatePass(...args) { return this._demo.generateGatePass(...args); }
  async searchItem(...args) { return this._demo.searchItem(...args); }
  async searchBin(...args) { return this._demo.searchBin(...args); }
  async trackPallet(...args) { return this._demo.trackPallet(...args); }

  async getTransferDocuments(...args) { return this._demo.getTransferDocuments(...args); }
  async getTransferDocument(...args) { return this._demo.getTransferDocument(...args); }
  async validateTransferSplitBin(...args) { return this._demo.validateTransferSplitBin(...args); }
  async suggestTransferSplitBin(...args) { return this._demo.suggestTransferSplitBin(...args); }
  async confirmTransferItem(...args) { return this._demo.confirmTransferItem(...args); }

  async getQuarantineDocuments(...args) { return this._demo.getQuarantineDocuments(...args); }
  async getQuarantineDocument(...args) { return this._demo.getQuarantineDocument(...args); }
  async validateQuarantineSplitBin(...args) { return this._demo.validateQuarantineSplitBin(...args); }
  async suggestQuarantineSplitBin(...args) { return this._demo.suggestQuarantineSplitBin(...args); }
  async confirmQuarantineItem(...args) { return this._demo.confirmQuarantineItem(...args); }
}

module.exports = HybridDataSource;