// src/data/adapters/hybridDataSource.js
const demoDataSource = require('./demoDataSource');
const BusinessCentralDataSource = require('./businessCentralDataSource');

/**
 * Makes a genuinely phased rollout possible: individual methods can be
 * routed to Business Central while every other method stays on demo data,
 * AT THE SAME TIME, in the same deployment — unlike DATA_SOURCE=
 * businessCentral directly, which switches the ENTIRE adapter at once and
 * breaks every module Business Central integration hasn't reached yet
 * (Transfer, Quarantine, Verify & Pack, etc. all throw BC_NOT_IMPLEMENTED
 * the moment that flag flips). Migrated so far: Put Away, Bin Inquiry,
 * Pick.
 *
 * Put Away's read (getPutAwayDocuments/getPutAwayDocument) and confirm
 * (confirmPutAwayItem) are routed INDEPENDENTLY, each behind its own env
 * var — reading from Business Central is low-risk (nothing changes),
 * confirming WRITES to a live inventory system, so being able to verify
 * reads before ever trusting writes is the point, not a detail to
 * collapse into one flag.
 *
 * Each future phase is one change here: move a method's line from the
 * "always demo" section to the routed section, backed by its own env var
 * the same way PUT_AWAY_READ_SOURCE/PUT_AWAY_CONFIRM_SOURCE work below.
 * Nothing else in the codebase needs to change — routes/controllers only
 * ever talk to `dataSource` from dataSourceFactory.js, never a specific
 * adapter.
 */
class HybridDataSource {
  constructor({
    businessCentralConfig,
    putAwayReadSource,
    putAwayConfirmSource,
    putAwaySplitSource,
    binInquirySource,
    pickReadSource,
    pickConfirmSource,
  }) {
    this._demo = demoDataSource;
    this._bc = new BusinessCentralDataSource(businessCentralConfig);
    this._putAwayReadSource = putAwayReadSource; // 'demo' | 'businessCentral'
    this._putAwayConfirmSource = putAwayConfirmSource; // 'demo' | 'businessCentral'
    // Routing is wired up now even though businessCentralDataSource.js's
    // validatePutAwayBin/suggestPutAwayBin are still _notImplemented() —
    // see this class's constructor doc for why: the day someone
    // implements them for real (once Business Central exposes a
    // capacity-aware endpoint), flipping this one flag should be the
    // ONLY remaining step. No hybridDataSource.js change needed at that
    // point, since the plumbing is already here waiting.
    this._putAwaySplitSource = putAwaySplitSource; // 'demo' | 'businessCentral'
    this._binInquirySource = binInquirySource; // 'demo' | 'businessCentral'
    // Pick — same read/confirm split as Put Away, for the same reason:
    // reads change nothing, confirm WRITES to live inventory and
    // registers the pick. Taken from the constructor when
    // dataSourceFactory.js passes them, otherwise straight from the
    // environment (PICK_READ_SOURCE / PICK_CONFIRM_SOURCE), so enabling
    // Pick needs only .env lines — no factory or config change. Anything
    // other than 'businessCentral' (including unset) means demo.
    this._pickReadSource = pickReadSource || process.env.PICK_READ_SOURCE || 'demo';
    this._pickConfirmSource = pickConfirmSource || process.env.PICK_CONFIRM_SOURCE || 'demo';
  }

  /// For the startup log line, so the terminal shows where Pick is routed.
  describePickRouting() {
    return { pickRead: this._pickReadSource, pickConfirm: this._pickConfirmSource };
  }

  _putAwayReadTarget() {
    return this._putAwayReadSource === 'businessCentral' ? this._bc : this._demo;
  }

  _putAwayConfirmTarget() {
    return this._putAwayConfirmSource === 'businessCentral' ? this._bc : this._demo;
  }

  _putAwaySplitTarget() {
    return this._putAwaySplitSource === 'businessCentral' ? this._bc : this._demo;
  }

  _pickReadTarget() {
    return this._pickReadSource === 'businessCentral' ? this._bc : this._demo;
  }

  _pickConfirmTarget() {
    return this._pickConfirmSource === 'businessCentral' ? this._bc : this._demo;
  }

  _binInquiryTarget() {
    return this._binInquirySource === 'businessCentral' ? this._bc : this._demo;
  }

  // ---------------- Put Away — read and confirm are independently routable ----------------
  async getPutAwayDocuments(...args) {
    return this._putAwayReadTarget().getPutAwayDocuments(...args);
  }

  async getPutAwayDocument(...args) {
    return this._putAwayReadTarget().getPutAwayDocument(...args);
  }

  /// Deliberately a SEPARATE flag from read, not reused — reading from
  /// Business Central is low-risk (nothing changes), confirming WRITES to
  /// a live inventory system. Being able to verify reads against real
  /// data before ever trusting writes to it is the whole point of
  /// keeping these independent, not a detail to collapse away.
  async confirmPutAwayItem(...args) {
    return this._putAwayConfirmTarget().confirmPutAwayItem(...args);
  }

  /// Same routing flag as confirmPutAwayItem — the batch endpoint
  /// (Section 2.7) is the same "writes to a live inventory system"
  /// concern, just replacing N per-line PATCH calls with one call per
  /// bin/document. Not a new flag: a deployment that's already verified
  /// confirmPutAwayItem against real Business Central data doesn't need
  /// to separately re-verify this before it's trusted — it's the same
  /// write path, batched.
  async confirmPutAwayBatch(...args) {
    return this._putAwayConfirmTarget().confirmPutAwayBatch(...args);
  }

  /// Same routing flag as confirmPutAwayItem, not read — Register is part
  /// of the same "writes to Business Central" lifecycle as confirming a
  /// line, fired once every line on a document is done. Keeping it on the
  /// confirm flag (rather than adding a third, separate one) means the
  /// two can never end up out of sync with each other — no state where
  /// line confirms go to Business Central but the final Register call
  /// silently doesn't, or vice versa.
  async registerPutAway(...args) {
    return this._putAwayConfirmTarget().registerPutAway(...args);
  }

  // validate-bin/suggest-bin still have no REAL Business Central
  // implementation (see businessCentralDataSource.js's class doc — no
  // capacity field on /Bins), so this always resolves to demo in
  // practice today regardless of PUT_AWAY_SPLIT_SOURCE's value — but the
  // routing itself is real and ready for the day that changes.
  async validatePutAwayBin(...args) {
    return this._putAwaySplitTarget().validatePutAwayBin(...args);
  }

  async suggestPutAwayBin(...args) {
    return this._putAwaySplitTarget().suggestPutAwayBin(...args);
  }

  /// check-bin is now built on the SAME GET /Bins lookup Bin Inquiry
  /// already uses (see businessCentralDataSource.js's checkPutAwayBin
  /// doc) — routed through BIN_INQUIRY_SOURCE, not a new flag of its
  /// own, since it's genuinely the same underlying Business Central
  /// capability as searchBin/listBins, not a Put Away write. A
  /// deployment that's already confirmed Bin Inquiry works against real
  /// data gets this for free, without needing to separately configure
  /// and verify it.
  async checkPutAwayBin(...args) {
    return this._binInquiryTarget().checkPutAwayBin(...args);
  }

  // ---------------- Pick — read and confirm independently routable ----------------
  async getPickDocuments(...args) { return this._pickReadTarget().getPickDocuments(...args); }
  async getPickDocument(...args) { return this._pickReadTarget().getPickDocument(...args); }

  /// Confirm, batch confirm and register share ONE flag — they are the
  /// same "writes to Business Central" lifecycle, and must never split
  /// (scans going to BC while Register silently goes to demo, or the
  /// reverse).
  async confirmPickItem(...args) { return this._pickConfirmTarget().confirmPickItem(...args); }
  async confirmPickBatch(...args) { return this._pickConfirmTarget().confirmPickBatch(...args); }
  async registerPick(...args) { return this._pickConfirmTarget().registerPick(...args); }

  // ---------------- Everything else — always demo until its own phase ----------------
  async getUnverifiedPicks(...args) { return this._demo.getUnverifiedPicks(...args); }
  async getVerifyPick(...args) { return this._demo.getVerifyPick(...args); }
  async submitVerifyPack(...args) { return this._demo.submitVerifyPack(...args); }
  async confirmShipLoad(...args) { return this._demo.confirmShipLoad(...args); }
  async generateGatePass(...args) { return this._demo.generateGatePass(...args); }
  async searchItem(...args) { return this._demo.searchItem(...args); }

  /// Independently routable — a read-only lookup, not tied to Put Away's
  /// read/confirm flags at all (Bin Inquiry is its own module). Second
  /// argument ({ locationCode }) passes straight through; see
  /// businessCentralDataSource.js's searchBin for the full mapping
  /// (Section 2.2.2 — bin metadata, contents and lot detail in one call).
  async searchBin(...args) {
    return this._binInquiryTarget().searchBin(...args);
  }

  /// Same routing flag as searchBin — same module, same concern.
  async listBins(...args) {
    return this._binInquiryTarget().listBins(...args);
  }

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