// src/data/adapters/demoDataSource.js
// src/data/adapters/demoDataSource.js
const ApiError = require('../../utils/apiError');

/**
 * In-memory demo data source. Seeded with the same documents, SKUs, and
 * customers as the approved HTML prototype so a fresh checkout behaves
 * identically to what Klan Logistics already reviewed and signed off on.
 * State mutates in memory as confirmations come in (a put-away/pick item
 * gets marked done, a document flips to "complete" once every line is
 * confirmed) so the app's auto-advance flow has something real to react to
 * — but nothing here persists across a server restart. That's intentional:
 * this adapter exists to unblock front-end development before Business
 * Central access is available, not to be a system of record.
 */
class DemoDataSource {
  constructor() {
    this._putAwayDocs = seedPutAwayDocs();
    this._pickDocs = seedPickDocs();
    this._verifyPicks = seedVerifyPicks();
    this._transferDocs = seedTransferDocs();
    this._quarantineDocs = seedQuarantineDocs();
    this._gatePassSeq = 800;

    // Split-bin validation (put-away short/split flow, operator-scanned
    // candidate path). Kept for a possible future manual-override route —
    // not currently called by the app's "Stop & Split" flow, which now
    // uses suggestPutAwayBin below instead of asking the operator to scan
    // a candidate themselves.
    this._freeSplitBins = new Set(['BIN-A01-03', 'BIN-A01-04', 'BIN-B02-01', 'BIN-C03-07']);
    this._consumedSplitBins = new Set();

    // Physical bin capacity/occupancy registry. Shared across Put Away's
    // "Stop & Split" auto-suggest flow AND Item Transfer — a single
    // source of truth for what's physically in each bin, so a transfer
    // out of RCV-C1 and a put-away topup into RCV-C1 can never disagree
    // about how much SKU-2001 is actually there. One sku per bin at a
    // time is a deliberate simplification (occupantSku is null when
    // empty), matching how the physical floor bins in this warehouse
    // actually work.
    this._binRegistry = {
      'RCV-A1': { capacity: 50, occupantSku: null, currentQty: 0 },
      'RCV-A2': { capacity: 20, occupantSku: null, currentQty: 0 },
      'RCV-B1': { capacity: 30, occupantSku: null, currentQty: 0 },
      'RCV-B2': { capacity: 75, occupantSku: null, currentQty: 0 },
      // Candidate destinations the app can be handed back by
      // suggestPutAwayBin — a mix of empty bins and a bin already holding
      // stock of PA-00123's sku, to exercise both the "empty bin" and
      // "topup" paths.
      'RCV-B1-ALT': { capacity: 40, occupantSku: null, currentQty: 0 },
      'RCV-C1': { capacity: 60, occupantSku: 'SKU-2001', currentQty: 15 },
      'RCV-C2': { capacity: 25, occupantSku: null, currentQty: 0 },
      // Floor storage bins seeded with stock, for exercising Item
      // Transfer's "scan a source bin that already has something in it"
      // flow independent of any put-away document.
      'A-05-01': { capacity: 40, occupantSku: 'SKU-BOLT-M6', currentQty: 18 },
      'A-05-02': { capacity: 40, occupantSku: 'SKU-BOLT-M6', currentQty: 6 },
      'B-01-01': { capacity: 60, occupantSku: 'SKU-NAIL-2IN', currentQty: 24 },
      'B-03-04': { capacity: 30, occupantSku: 'SKU-CLIP-RET', currentQty: 9 },
      'C-02-01': { capacity: 40, occupantSku: null, currentQty: 0 },
      'REPAIR-STAGING': { capacity: 200, occupantSku: null, currentQty: 0 },
      // Quarantine zones — flagged with isQuarantineZone so
      // validateQuarantineSplitBin (and suggestQuarantineSplitBin) reject
      // any ordinary storage bin even if it has free capacity. A regular
      // floor bin is never a valid quarantine destination, and a
      // quarantine bin is never a valid Item Transfer split destination
      // either — validateTransferSplitBin/suggestTransferSplitBin don't
      // filter on this flag, so a quarantine bin would technically be
      // offered as a transfer split target today if it had free capacity
      // — worth a follow-up guard if that needs to be hard-blocked too.
      'QZ-DAMAGED': { capacity: 100, occupantSku: null, currentQty: 0, isQuarantineZone: true },
      'QZ-HOLD': { capacity: 60, occupantSku: null, currentQty: 0, isQuarantineZone: true },
    };
  }

  // ------------------------------------------------------------------
  // Put Away
  // ------------------------------------------------------------------
  async getPutAwayDocuments() {
    return { documents: Object.values(this._putAwayDocs).map(stripInternal) };
  }

  async getPutAwayDocument(docId) {
    const doc = this._putAwayDocs[docId];
    if (!doc) throw ApiError.notFound(`Put away document "${docId}" not found.`);
    return stripInternal(doc);
  }

  async confirmPutAwayItem(payload) {
    const { docId, sku, scanLog } = payload;
    const doc = this._putAwayDocs[docId];
    if (!doc) throw ApiError.notFound(`Put away document "${docId}" not found.`);
    const item = doc.items.find((i) => i.sku === sku);
    if (!item) throw ApiError.badRequest(`Item "${sku}" is not part of document "${docId}".`);

    doc._confirmed = doc._confirmed || new Set();
    doc._confirmed.add(sku);
    doc._scanLogs = doc._scanLogs || {};
    if (Array.isArray(scanLog)) doc._scanLogs[sku] = scanLog;
    doc.status = doc._confirmed.size >= doc.items.length ? 'complete' : 'inProgress';
    return { ok: true };
  }

  async validatePutAwayBin(payload) {
    const { docId, binCode, sku, qty } = payload || {};
    if (!docId || !binCode || !sku || qty == null) {
      throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
    }

    const normalized = String(binCode).trim().toUpperCase();

    if (this._consumedSplitBins.has(normalized)) {
      return { accepted: false, reason: 'Bin already assigned to another split.' };
    }
    if (!this._freeSplitBins.has(normalized)) {
      return { accepted: false, reason: 'Bin is occupied or not recognized.' };
    }

    this._consumedSplitBins.add(normalized);
    return { accepted: true };
  }

  /// Auto-suggest flow for the "Stop & Split" button. The operator does
  /// NOT scan a candidate here — the app asks the middleware to find one,
  /// which may be an empty bin or a "topup" of a bin already holding the
  /// same sku. Prefers a topup over an empty bin (consolidating stock is
  /// generally preferable to spreading it further), and picks the
  /// smallest empty bin that still fits the remainder as a best-fit
  /// tiebreak among empty candidates.
  ///
  /// Reserves the chosen bin's capacity immediately (updates the
  /// registry) rather than waiting for the operator's eventual /confirm
  /// call, so two concurrent short/split events can't both be handed the
  /// same capacity — mirroring how a real WMS would place a soft
  /// allocation hold at suggestion time.
  ///
  /// excludeBinCodes covers EVERY bin already belonging to this Put Away
  /// document, not just the one line came up short — an auto-assigned
  /// remainder must never land in a bin already tied to this same task,
  /// even a DIFFERENT line's destination, to avoid the confusing
  /// "didn't I already handle this bin for a different item" situation.
  async suggestPutAwayBin(payload) {
    const { docId, sku, qty, excludeBinCodes } = payload || {};
    if (!docId || !sku || qty == null) {
      throw ApiError.badRequest('docId, sku, and qty are required.');
    }
    return this._suggestBinForSku(sku, qty, excludeBinCodes);
  }

  /// Shared bin-suggestion logic behind suggestPutAwayBin,
  /// suggestTransferSplitBin, and suggestQuarantineSplitBin — all ask
  /// "find/reserve a bin with room for [qty] units of [sku]", identical
  /// selection rules (prefer topping up existing stock, else best-fit
  /// among empty bins), just triggered from different flows and with
  /// different exclusion sets. [excludeBinCodes] accepts a single code
  /// (string), a list of codes, or null/undefined — normalized to a Set
  /// below either way. Reserves capacity immediately in the registry (see
  /// suggestPutAwayBin's original doc for why) rather than waiting for
  /// the eventual confirm call.
  _suggestBinForSku(sku, qty, excludeBinCodes) {
    const excludedList = excludeBinCodes == null
      ? []
      : Array.isArray(excludeBinCodes)
        ? excludeBinCodes
        : [excludeBinCodes];
    const excluded = new Set(excludedList.filter(Boolean).map((c) => String(c).trim().toUpperCase()));

    const entries = Object.entries(this._binRegistry).filter(([code]) => !excluded.has(code));

    const topUpCandidates = entries
      .filter(([, bin]) => bin.occupantSku === sku && bin.capacity - bin.currentQty >= qty)
      .sort((a, b) => b[1].currentQty - a[1].currentQty); // prefer the fullest existing stock first

    const chosen = topUpCandidates.length > 0
      ? topUpCandidates[0]
      : entries
          .filter(([, bin]) => !bin.occupantSku && bin.capacity >= qty)
          .sort((a, b) => a[1].capacity - b[1].capacity)[0]; // best-fit among empty bins

    if (!chosen) {
      return { available: false, reason: `No bin with ${qty} units of free capacity was found.` };
    }

    const [binCode, bin] = chosen;
    const isTopUp = bin.occupantSku === sku;
    const currentQtyBeforeReservation = bin.currentQty;

    bin.currentQty += qty;
    if (!bin.occupantSku) bin.occupantSku = sku;

    return {
      available: true,
      binCode,
      isTopUp,
      currentQty: currentQtyBeforeReservation,
      capacityRemaining: bin.capacity - bin.currentQty,
    };
  }

  /// MOCKED for now, per product decision — a real implementation would
  /// query Business Central's bin/location master data directly. Only
  /// ever asked for a line Business Central did NOT pre-assign a
  /// destination for (see dataSource.interface.js) — the operator scans
  /// a bin before scanning any actual units, but the app already knows
  /// WHICH line it's assigning a bin for at that point (there's no
  /// "assign a bin with no idea what's going in it" case), so sku IS
  /// available here despite no units being scanned yet. Deliberately
  /// simpler than suggestPutAwayBin/validatePutAwayBin though: this never
  /// checks CAPACITY (no qty is known/relevant yet), only whether the
  /// bin's current occupant, if any, is unrelated to this sku.
  ///
  /// Three outcomes: empty bin -> accepted. Occupied by the SAME sku ->
  /// accepted (a legitimate top-up, same as suggestPutAwayBin's isTopUp
  /// case). Occupied by a DIFFERENT sku -> rejected — a bin already
  /// holding unrelated stock must never be handed to the operator as a
  /// valid destination. No reservation happens here either way — the
  /// bin's actual occupancy only changes once the operator scans real
  /// items into it and that gets confirmed, same as any other line.
  async checkPutAwayBin(payload) {
    const { binCode, sku } = payload || {};
    const normalizedBin = String(binCode || '').trim().toUpperCase();
    const normalizedSku = String(sku || '').trim().toUpperCase();
    const bin = this._binRegistry[normalizedBin];

    if (!bin) {
      return { available: false, reason: `Bin "${normalizedBin}" is not recognized.` };
    }
    if (bin.occupantSku && bin.occupantSku !== normalizedSku) {
      return { available: false, reason: `Bin ${normalizedBin} already holds unrelated stock (${bin.occupantSku}).` };
    }
    return { available: true };
  }

  /// Demo has no Business Central "Register" action to call — by the time
  /// every line is confirmed (see confirmPutAwayItem above, which already
  /// flips doc.status to 'complete' once doc._confirmed covers every
  /// item), there's nothing further for a demo document's Register step
  /// to do. Trivially succeeds so the app-side flow (which calls this
  /// unconditionally once a document completes) never has to special-case
  /// which adapter it's talking to.
  async registerPutAway(payload) {
    const { docId } = payload || {};
    if (!docId) throw ApiError.badRequest('docId is required.');
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Pick
  // ------------------------------------------------------------------
  async getPickDocuments() {
    return { documents: Object.values(this._pickDocs).map(stripInternal) };
  }

  async getPickDocument(docId) {
    const doc = this._pickDocs[docId];
    if (!doc) throw ApiError.notFound(`Pick document "${docId}" not found.`);
    return stripInternal(doc);
  }

  async confirmPickItem(payload) {
    const { docId, sku, scanLog } = payload;
    const doc = this._pickDocs[docId];
    if (!doc) throw ApiError.notFound(`Pick document "${docId}" not found.`);
    const item = doc.items.find((i) => i.sku === sku);
    if (!item) throw ApiError.badRequest(`Item "${sku}" is not part of document "${docId}".`);

    doc._confirmed = doc._confirmed || new Set();
    doc._confirmed.add(sku);
    doc._scanLogs = doc._scanLogs || {};
    if (Array.isArray(scanLog)) doc._scanLogs[sku] = scanLog;
    doc.status = doc._confirmed.size >= doc.items.length ? 'complete' : 'inProgress';
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Verify & Pack
  // ------------------------------------------------------------------
  async getUnverifiedPicks() {
    return { picks: Object.values(this._verifyPicks) };
  }

  async getVerifyPick(orderId) {
    const pick = this._verifyPicks[orderId];
    if (!pick) throw ApiError.notFound(`Pick #${orderId} not found or already verified.`);
    return pick;
  }

  async submitVerifyPack(payload) {
    const { orderId } = payload;
    if (!this._verifyPicks[orderId]) {
      throw ApiError.notFound(`Pick #${orderId} not found or already verified.`);
    }
    delete this._verifyPicks[orderId];
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Ship
  // ------------------------------------------------------------------
  async confirmShipLoad(payload) {
    if (!Array.isArray(payload.pallets) || payload.pallets.length === 0) {
      throw ApiError.badRequest('At least one pallet is required to confirm a load.');
    }
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Gate Pass
  // ------------------------------------------------------------------
  async generateGatePass(payload) {
    this._gatePassSeq += 1;
    const year = new Date().getFullYear();
    return {
      gatePassNumber: `GP-${year}-${String(this._gatePassSeq).padStart(4, '0')}`,
      materialRequest: payload.materialRequest || null,
      shippingDoc: payload.shippingDoc,
      vehicle: payload.vehicle || null,
      palletCount: payload.palletCount || 1,
    };
  }

  // ------------------------------------------------------------------
  // Inquiries (read-only)
  // ------------------------------------------------------------------
  async searchItem(query) {
    return {
      sku: 'HDW-8821-BLT',
      name: 'Steel Bolt 10mm',
      stockLines: [
        { zone: 'A', location: 'A-101', bin: 'B-05', qty: 150, batch: 'B2023-01', receivedDate: '12 Oct', receivedBy: 'WH-JDOE' },
        { zone: 'C', location: 'C-202', bin: 'D-12', qty: 85, batch: 'B2023-04', receivedDate: '28 Oct', receivedBy: 'WH-ASMITH' },
      ],
    };
  }

  async searchBin(code) {
    return {
      binCode: code || 'B-05',
      location: 'A-101',
      isActive: true,
      items: [
        { name: 'Steel Bolt 10mm', sku: 'SB-10-M', batch: 'B2023-01', units: 150 },
        { name: 'Hex Nut M10', sku: 'HN-M10-X', batch: 'B2023-02', units: 300 },
      ],
      lastSyncedAt: new Date().toISOString(),
    };
  }

  async trackPallet(palletId) {
    return {
      palletId: palletId || 'PLT-98765',
      status: 'In transit',
      lastLocation: 'Dock 4B · Zone C',
      lastTimestamp: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      contents: [
        { name: 'Industrial Bearing 50mm', sku: 'IND-BRG-050', batch: 'BT-X9', units: 20 },
        { name: 'Lubricant Spray 400ml', sku: 'LUB-SPR-400', batch: 'BT-X12', units: 50 },
      ],
    };
  }

  // ------------------------------------------------------------------
  // Item Transfer — document-driven. Business Central decides both the
  // source and destination bin for every line before the document is
  // assigned; the app's job is to have the operator execute and confirm
  // via scanning, not to judge or choose bins live. This mirrors Put
  // Away's shape almost exactly (see getPutAwayDocuments/confirmPutAwayItem
  // above) with sourceBinCode added per line.
  // ------------------------------------------------------------------
  async getTransferDocuments() {
    return { documents: Object.values(this._transferDocs).map(stripInternal) };
  }

  async getTransferDocument(docId) {
    const doc = this._transferDocs[docId];
    if (!doc) throw ApiError.notFound(`Transfer document "${docId}" not found.`);
    return stripInternal(doc);
  }

  /// Records one confirmed line movement. Still updates the shared bin
  /// registry (decrement source, increment destination) so Quarantine's
  /// ad-hoc bin lookups and Put Away's suggestPutAwayBin see a
  /// floor-consistent picture — but unlike the old ad-hoc design, this is
  /// bookkeeping AFTER the fact, not a live capacity check gating the
  /// confirm. Business Central already decided this movement was valid
  /// when the document was created.
  async confirmTransferItem(payload) {
    const { docId, sku, sourceBinCode, destinationBinCode, qty, scanLog } = payload;
    const doc = this._transferDocs[docId];
    if (!doc) throw ApiError.notFound(`Transfer document "${docId}" not found.`);

    // Match by (sku, sourceBinCode) only — NOT destinationBinCode. A
    // confirm's destination is either the originally-assigned one, or a
    // live-approved split replacement (see validateTransferSplitBin/
    // suggestTransferSplitBin) that was never part of the original plan.
    // Requiring an exact destination match here would reject every
    // legitimate split-remainder confirm.
    const line = doc.items.find((i) => i.sku === sku && i.sourceBinCode === sourceBinCode);
    if (!line) throw ApiError.badRequest(`Line (${sku} from ${sourceBinCode}) is not part of document "${docId}".`);

    // Accumulates rather than sets, so a line split across two confirm
    // calls (settled at the original destination + remainder at a new
    // one) is correctly tracked as one line reaching its full qty in
    // two steps, not two separate half-satisfied lines.
    doc._confirmedQty = doc._confirmedQty || {};
    const key = `${sku}|${sourceBinCode}`;
    doc._confirmedQty[key] = (doc._confirmedQty[key] || 0) + qty;

    doc._scanLogs = doc._scanLogs || {};
    if (Array.isArray(scanLog)) doc._scanLogs[key] = [...(doc._scanLogs[key] || []), ...scanLog];

    const allLinesDone = doc.items.every((i) => (doc._confirmedQty[`${i.sku}|${i.sourceBinCode}`] || 0) >= i.qty);
    doc.status = allLinesDone ? 'complete' : 'inProgress';

    const source = this._binRegistry[sourceBinCode];
    const destination = this._binRegistry[destinationBinCode];
    if (source && source.occupantSku === sku) {
      source.currentQty = Math.max(0, source.currentQty - qty);
      if (source.currentQty === 0) source.occupantSku = null;
    }
    if (destination) {
      destination.currentQty += qty;
      if (!destination.occupantSku) destination.occupantSku = sku;
    }

    return { ok: true };
  }

  /// SPLIT-ONLY — see transfer.routes.js doc comment. Never used to
  /// decide a line's original destination.
  async validateTransferSplitBin(payload) {
    const { binCode, sku, qty } = payload || {};
    const normalized = String(binCode).trim().toUpperCase();
    const bin = this._binRegistry[normalized];

    if (!bin) {
      return { accepted: false, reason: `Bin "${normalized}" is not recognized.` };
    }
    if (bin.occupantSku && bin.occupantSku !== sku) {
      return { accepted: false, reason: `Bin ${normalized} already holds a different item (${bin.occupantSku}).` };
    }
    if (bin.capacity - bin.currentQty < qty) {
      return { accepted: false, reason: `Bin ${normalized} only has ${bin.capacity - bin.currentQty} unit(s) of free capacity.` };
    }
    return { accepted: true };
  }

  /// SPLIT-ONLY — reuses the exact same selection logic as
  /// suggestPutAwayBin via [_suggestBinForSku].
  async suggestTransferSplitBin(payload) {
    const { sku, qty, excludeBinCode } = payload || {};
    return this._suggestBinForSku(sku, qty, excludeBinCode);
  }

  // ------------------------------------------------------------------
  // Quarantine — document-driven, per Klan's control requirement: same
  // pattern as Item Transfer (Business Central decides source bin, item,
  // qty, quarantine destination, AND reason before the document is
  // assigned), including the same split-only live escape hatch for when
  // the assigned quarantine bin turns out short of room on arrival.
  // ------------------------------------------------------------------
  async getQuarantineDocuments() {
    return { documents: Object.values(this._quarantineDocs).map(stripInternal) };
  }

  async getQuarantineDocument(docId) {
    const doc = this._quarantineDocs[docId];
    if (!doc) throw ApiError.notFound(`Quarantine document "${docId}" not found.`);
    return stripInternal(doc);
  }

  /// Same accumulate-by-(sku,sourceBinCode) approach as
  /// confirmTransferItem, for the same reason: a split-remainder confirm
  /// targets a destination that was never part of the original plan.
  async confirmQuarantineItem(payload) {
    const { docId, sku, sourceBinCode, destinationBinCode, qty, scanLog } = payload;
    const doc = this._quarantineDocs[docId];
    if (!doc) throw ApiError.notFound(`Quarantine document "${docId}" not found.`);

    const line = doc.items.find((i) => i.sku === sku && i.sourceBinCode === sourceBinCode);
    if (!line) throw ApiError.badRequest(`Line (${sku} from ${sourceBinCode}) is not part of document "${docId}".`);

    doc._confirmedQty = doc._confirmedQty || {};
    const key = `${sku}|${sourceBinCode}`;
    doc._confirmedQty[key] = (doc._confirmedQty[key] || 0) + qty;

    doc._scanLogs = doc._scanLogs || {};
    if (Array.isArray(scanLog)) doc._scanLogs[key] = [...(doc._scanLogs[key] || []), ...scanLog];

    const allLinesDone = doc.items.every((i) => (doc._confirmedQty[`${i.sku}|${i.sourceBinCode}`] || 0) >= i.qty);
    doc.status = allLinesDone ? 'complete' : 'inProgress';

    const source = this._binRegistry[sourceBinCode];
    const destination = this._binRegistry[destinationBinCode];
    if (source && source.occupantSku === sku) {
      source.currentQty = Math.max(0, source.currentQty - qty);
      if (source.currentQty === 0) source.occupantSku = null;
    }
    if (destination) {
      destination.currentQty += qty;
      if (!destination.occupantSku) destination.occupantSku = sku;
    }

    return { ok: true };
  }

  /// SPLIT-ONLY — the operator has already arrived at the Business
  /// Central-assigned quarantine bin and found it physically short.
  /// UNLIKE Transfer's split (which can land anywhere with capacity),
  /// the replacement here MUST also be flagged isQuarantineZone — damaged
  /// stock cannot land in a normal picking bin just because that's what
  /// had room.
  async validateQuarantineSplitBin(payload) {
    const { binCode, sku, qty } = payload || {};
    const normalized = String(binCode).trim().toUpperCase();
    const bin = this._binRegistry[normalized];

    if (!bin) {
      return { accepted: false, reason: `Bin "${normalized}" is not recognized.` };
    }
    if (!bin.isQuarantineZone) {
      return { accepted: false, reason: `${normalized} is not a quarantine zone. Scan a designated quarantine bin.` };
    }
    if (bin.occupantSku && bin.occupantSku !== sku) {
      return { accepted: false, reason: `Bin ${normalized} already holds a different item (${bin.occupantSku}).` };
    }
    if (bin.capacity - bin.currentQty < qty) {
      return { accepted: false, reason: `Bin ${normalized} only has ${bin.capacity - bin.currentQty} unit(s) of free capacity.` };
    }
    return { accepted: true };
  }

  /// SPLIT-ONLY auto-assign — same [_suggestBinForSku] selection logic as
  /// Put Away/Transfer, but restricted to bins flagged isQuarantineZone.
  async suggestQuarantineSplitBin(payload) {
    const { sku, qty, excludeBinCode } = payload || {};
    const excluded = excludeBinCode ? String(excludeBinCode).trim().toUpperCase() : null;
    const entries = Object.entries(this._binRegistry).filter(([code, bin]) => code !== excluded && bin.isQuarantineZone);

    const topUpCandidates = entries
      .filter(([, bin]) => bin.occupantSku === sku && bin.capacity - bin.currentQty >= qty)
      .sort((a, b) => b[1].currentQty - a[1].currentQty);

    const chosen = topUpCandidates.length > 0
      ? topUpCandidates[0]
      : entries.filter(([, bin]) => !bin.occupantSku && bin.capacity >= qty).sort((a, b) => a[1].capacity - b[1].capacity)[0];

    if (!chosen) {
      return { available: false, reason: `No quarantine zone with ${qty} units of free capacity was found.` };
    }

    const [binCode, bin] = chosen;
    const isTopUp = bin.occupantSku === sku;
    const currentQtyBeforeReservation = bin.currentQty;

    bin.currentQty += qty;
    if (!bin.occupantSku) bin.occupantSku = sku;

    return {
      available: true,
      binCode,
      isTopUp,
      currentQty: currentQtyBeforeReservation,
      capacityRemaining: bin.capacity - bin.currentQty,
    };
  }
}

function stripInternal(doc) {
  const { _confirmed, _confirmedQty, _scanLogs, ...rest } = doc;
  return rest;
}

function seedPutAwayDocs() {
  return {
    'PA-00125': {
      docId: 'PA-00125',
      sourceWarehouseReceipt: 'WHR-54323',
      status: 'inProgress',
      receivedFromLocation: 'DOCK-1',
      items: [
        { sku: 'SKU-1001', description: '12oz Organic Coffee Beans', qty: 50, location: 'RCV-A1' },
        { sku: 'SKU-1002', description: 'Stainless Steel Mixing Bowl', qty: 20, location: 'RCV-A2' },
      ],
    },
    'PA-00123': {
      docId: 'PA-00123',
      sourceWarehouseReceipt: 'WHR-54321',
      status: 'assigned',
      receivedFromLocation: 'DOCK-2',
      items: [{ sku: 'SKU-2001', description: 'Cotton Packing Blankets', qty: 40, location: 'RCV-B1' }],
    },
    'PA-00124': {
      docId: 'PA-00124',
      sourceWarehouseReceipt: 'WHR-54322',
      status: 'assigned',
      receivedFromLocation: 'DOCK-1',
      items: [{ sku: 'SKU-3001', description: 'Galvanized Steel Brackets', qty: 75, location: 'RCV-B2' }],
    },
    'PA-00127': {
      docId: 'PA-00127',
      sourceWarehouseReceipt: 'WHR-54324',
      status: 'assigned',
      receivedFromLocation: 'DOCK-2',
      // Mixes a BC-assigned line (used without exception, same as every
      // other document) with two UNASSIGNED lines (location: null) — the
      // operator picks a bin for these on the floor, scanned and checked
      // live via POST /put-away/check-bin before any item is scanned.
      items: [
        { sku: 'SKU-1001', description: '12oz Organic Coffee Beans', qty: 30, location: 'RCV-A1' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 12, location: null },
        { sku: 'SKU-NAIL-2IN', description: 'Finish Nail, 2 inch', qty: 18, location: null },
      ],
    },
  };
}

function seedPickDocs() {
  const now = new Date();
  const inDays = (n) => new Date(now.getTime() + n * 86400000).toISOString();

  return {
    'WH-PICK-00123': {
      docId: 'WH-PICK-00123',
      shipmentRef: 'WHS-10567',
      dueDate: inDays(1),
      status: 'assigned',
      isHighPriority: true,
      items: [
        { sku: '12345-ABC', description: "Men's Blue T-Shirt, Large", qty: 1, location: 'A-08-03' },
        { sku: '67890-XYZ', description: 'Red Sneakers, Size 10', qty: 2, location: 'A-11-02' },
        { sku: '54321-JKL', description: 'Black Leather Wallet', qty: 1, location: 'B-02-05' },
      ],
    },
    'WH-PICK-00124': {
      docId: 'WH-PICK-00124',
      shipmentRef: 'WHS-10568',
      dueDate: inDays(2),
      status: 'inProgress',
      isHighPriority: false,
      items: [{ sku: '88213-ZZ', description: 'Blue Denim Jacket, Medium', qty: 3, location: 'C-04-01' }],
    },
    'WH-PICK-00125': {
      docId: 'WH-PICK-00125',
      shipmentRef: 'WHS-10569',
      dueDate: inDays(3),
      status: 'assigned',
      isHighPriority: false,
      items: [{ sku: '44120-QQ', description: 'Canvas Tote Bag', qty: 2, location: 'B-09-02' }],
    },
    'WH-PICK-00126': {
      docId: 'WH-PICK-00126',
      shipmentRef: 'WHS-10571',
      dueDate: inDays(2),
      status: 'assigned',
      isHighPriority: true,
      items: [
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 6, location: 'A-05-01' },
        { sku: 'SKU-WASH-M6', description: 'Flat Washer, M6', qty: 8, location: 'A-05-01' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 4, location: 'A-05-02' },
        { sku: 'SKU-NAIL-2IN', description: 'Finish Nail, 2 inch', qty: 12, location: 'B-01-01' },
        { sku: 'SKU-CLIP-RET', description: 'Retaining Clip', qty: 3, location: 'B-03-04' },
        { sku: 'SKU-SCREW-M4', description: 'Machine Screw, M4', qty: 5, location: 'B-03-04' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 2, location: 'C-02-01' },
      ],
    },
    'WH-PICK-00127': {
      docId: 'WH-PICK-00127',
      shipmentRef: 'WHS-10581',
      dueDate: inDays(0),
      status: 'assigned',
      isHighPriority: true,
      items: [
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 6, location: 'A-05-01' },
        { sku: 'SKU-WASH-M6', description: 'Flat Washer, M6', qty: 8, location: 'A-05-01' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 4, location: 'A-05-02' },
        { sku: 'SKU-NAIL-2IN', description: 'Finish Nail, 2 inch', qty: 12, location: 'B-01-01' },
        { sku: 'SKU-CLIP-RET', description: 'Retaining Clip', qty: 3, location: 'B-03-04' },
        { sku: 'SKU-SCREW-M4', description: 'Machine Screw, M4', qty: 5, location: 'B-03-04' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 2, location: 'C-02-01' },
      ],
    }
  };
}

function seedVerifyPicks() {
  return {
    12345: {
      orderId: '12345',
      customer: 'Global Imports',
      items: [
        { sku: 'PLT-003-C', name: 'Reinforced Steel Plates', location: 'Aisle 8, Shelf 4', expected: 12, verified: 12, status: 'ok', requiresPackaging: true },
        { sku: 'BLT-012-T', name: 'Titanium Bolts (Pack of 100)', location: 'Aisle 3, Shelf 2', expected: 5, verified: 0, status: 'pending', requiresPackaging: false },
        { sku: 'ROD-001-CF', name: 'Carbon Fiber Rods', location: 'Aisle 11, Shelf 1', expected: 3, verified: 0, status: 'pending', requiresPackaging: true },
        { sku: 'WIR-007-CU', name: 'Copper Wire Spool', location: 'Aisle 5, Shelf 1', expected: 16, verified: 15, status: 'under', requiresPackaging: true },
      ],
    },
    12346: {
      orderId: '12346',
      customer: 'Downtown Hardware',
      items: [{ sku: 'HNG-004-B', name: 'Brass Door Hinges', location: 'Aisle 2, Shelf 3', expected: 10, verified: 0, status: 'pending', requiresPackaging: true }],
    },
    12347: {
      orderId: '12347',
      customer: 'Metro Distribution',
      items: [{ sku: 'CBL-009-E', name: 'Ethernet Cable 10m', location: 'Aisle 6, Shelf 2', expected: 6, verified: 0, status: 'pending', requiresPackaging: true }],
    },
  };
}

function seedTransferDocs() {
  return {
    'TR-00301': {
      docId: 'TR-00301',
      status: 'assigned',
      // Many-to-one: two small bins of the SAME sku consolidating into
      // one bigger, currently-empty bin — both lines share
      // destinationBinCode. Matches "multiple small bins to one big bin"
      // from the product brief.
      items: [
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 18, sourceBinCode: 'A-05-01', destinationBinCode: 'C-02-01' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 6, sourceBinCode: 'A-05-02', destinationBinCode: 'C-02-01' },
      ],
    },
    'TR-00302': {
      docId: 'TR-00302',
      status: 'assigned',
      // One-to-many split: one source bin, one sku, split across two
      // different (empty) destinations with different quantities —
      // together consuming all 24 units B-01-01 holds.
      items: [
        { sku: 'SKU-NAIL-2IN', description: 'Finish Nail, 2 inch', qty: 15, sourceBinCode: 'B-01-01', destinationBinCode: 'RCV-C2' },
        { sku: 'SKU-NAIL-2IN', description: 'Finish Nail, 2 inch', qty: 9, sourceBinCode: 'B-01-01', destinationBinCode: 'REPAIR-STAGING' },
      ],
    },
    'TR-00303': {
      docId: 'TR-00303',
      status: 'assigned',
      // Straightforward one-to-one, repair-driven move. Note: this demo
      // adapter doesn't enforce single-sku-per-destination bookkeeping
      // across Transfer documents the way it does for Put Away/Quarantine
      // suggestions — REPAIR-STAGING can legitimately receive several
      // different skus from several different transfers, which is a
      // real staging-area pattern, not a bug worth guarding against here.
      items: [{ sku: 'SKU-CLIP-RET', description: 'Retaining Clip', qty: 9, sourceBinCode: 'B-03-04', destinationBinCode: 'REPAIR-STAGING' }],
    },
  };
}

function seedQuarantineDocs() {
  return {
    'QT-00501': {
      docId: 'QT-00501',
      status: 'assigned',
      // Reason arrives from BC on the line now (not chosen by the
      // operator) — matches the same control requirement driving
      // Transfer's redesign.
      items: [
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 4, sourceBinCode: 'A-05-01', destinationBinCode: 'QZ-DAMAGED', reasonCode: 'damaged', reasonNote: null },
      ],
    },
    'QT-00502': {
      docId: 'QT-00502',
      status: 'assigned',
      items: [
        { sku: 'SKU-CLIP-RET', description: 'Retaining Clip', qty: 9, sourceBinCode: 'B-03-04', destinationBinCode: 'QZ-HOLD', reasonCode: 'qualityHold', reasonNote: null },
      ],
    },
  };
}

module.exports = new DemoDataSource();
module.exports.DemoDataSource = DemoDataSource;