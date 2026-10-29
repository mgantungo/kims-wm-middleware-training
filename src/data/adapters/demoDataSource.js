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
    this._pallets = seedPallets();
    // Bins a pallet can be moved into (demo). maxPallets 1 = one pallet per bin.
    this._palletBins = {
      'A-01-01': { zoneCode: 'S-ZONE-A', takesPallets: true, maxPallets: 1 },
      'A-01-02': { zoneCode: 'S-ZONE-A', takesPallets: true, maxPallets: 1 },
      'A-02-01': { zoneCode: 'S-ZONE-A', takesPallets: true, maxPallets: 1 },
      'B-01-01': { zoneCode: 'S-ZONE-B', takesPallets: true, maxPallets: 1 },
      'B-02-03': { zoneCode: 'S-ZONE-B', takesPallets: true, maxPallets: 1 },
      'DISPATCH-1-': { zoneCode: 'DISP-ZONE', takesPallets: true, maxPallets: 20 },
      'RECEIVING-1-': { zoneCode: 'REC-ZONE', takesPallets: true, maxPallets: 20 },
      'QZ-HOLD': { zoneCode: 'Q-ZONE', takesPallets: true, maxPallets: 5 },
      'SHELF-C-01': { zoneCode: 'S-ZONE-C', takesPallets: false, maxPallets: 0 },
    };
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

  /// Demo counterpart to businessCentralDataSource.js's confirmPutAwayBatch
  /// — same entry shape ([{ sku, bcLineId, location, qty, scanLog? }]),
  /// but addresses each entry by sku (demo items have no real bcLineId)
  /// rather than by bcLineId. Applies each entry the same way
  /// confirmPutAwayItem already does, in order, so a document confirmed
  /// via the batch path ends up in an identical local state to one
  /// confirmed line-by-line — demo mode doesn't have Business Central's
  /// all-or-nothing rollback behavior to emulate (there's no real network
  /// call to fail partway through), so every entry here always succeeds.
  async confirmPutAwayBatch(payload) {
    const { docId, entries } = payload || {};
    const doc = this._putAwayDocs[docId];
    if (!doc) throw ApiError.notFound(`Put away document "${docId}" not found.`);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw ApiError.badRequest('confirmPutAwayBatch requires at least one entry.');
    }

    doc._confirmed = doc._confirmed || new Set();
    doc._scanLogs = doc._scanLogs || {};

    for (const entry of entries) {
      const item = doc.items.find((i) => i.sku === entry.sku);
      if (!item) throw ApiError.badRequest(`Item "${entry.sku}" is not part of document "${docId}".`);
      doc._confirmed.add(entry.sku);
      if (Array.isArray(entry.scanLog)) {
        // Later entries for the SAME sku (a serial-tracked line split
        // across many single-unit entries) extend the log rather than
        // overwrite it, so the full per-unit history survives even
        // though each entry only carries its own slice.
        doc._scanLogs[entry.sku] = [...(doc._scanLogs[entry.sku] || []), ...entry.scanLog];
      }
    }
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
  /// locationCode is accepted for signature parity with
  /// businessCentralDataSource.js's version (which genuinely needs it —
  /// see that method's doc for why) but ignored here — the demo bin
  /// registry has no location concept at all, same as listBins above.
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

  /// Demo counterpart to businessCentralDataSource.js's confirmPickBatch —
  /// same payload ({ docId, bcPickId?, entries: [{ sku, bcLineId?,
  /// location, qty, lotNo?, serialNo? }] }) and same response shape, so
  /// the app behaves identically whichever adapter PICK_CONFIRM_SOURCE
  /// points at. Demo items have no bcLineId, so entries are matched by
  /// sku; register is a no-op that always "succeeds".
  async confirmPickBatch(payload) {
    const { docId, entries } = payload || {};
    const doc = this._pickDocs[docId];
    if (!doc) throw ApiError.notFound(`Pick document "${docId}" not found.`);
    if (!Array.isArray(entries) || entries.length === 0) {
      throw ApiError.badRequest('confirmPickBatch requires at least one entry.');
    }
    doc._confirmed = doc._confirmed || new Set();
    for (const entry of entries) {
      if (!doc.items.some((i) => i.sku === entry.sku)) {
        throw ApiError.badRequest(`Item "${entry.sku}" is not part of document "${docId}".`);
      }
      doc._confirmed.add(entry.sku);
    }
    doc.status = doc._confirmed.size >= new Set(doc.items.map((i) => i.sku)).size ? 'complete' : 'inProgress';
    // register: false (the app's Update Pick / Partial Pick) only saves.
    if (payload.register === false) {
      return { ok: true, registerAttempted: false, registered: false, registerError: null };
    }
    return { ok: true, registerAttempted: true, registered: true, registerError: null };
  }

  /// Demo counterpart to businessCentralDataSource.js's checkPickBin. Demo
  /// data has no bin contents to check against, so any bin is accepted —
  /// same shape as the Business Central answer.
  async checkPickBin(payload) {
    const { binCode, sku } = payload || {};
    if (!binCode || !sku) throw ApiError.badRequest('binCode and sku are required.');
    return { available: true };
  }

  async registerPick(payload) {
    const { docId } = payload || {};
    if (!docId) throw ApiError.badRequest('docId is required.');
    // Demo data has nothing outstanding to keep open.
    return { ok: true, fullyRegistered: true };
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

  /// Lists every bin, for the "browse all bins" view — distinct from
  /// searchBin above, which looks up ONE bin by code and (in this demo
  /// adapter) returns a fixed fake response regardless of what's
  /// searched. This instead exposes the REAL shared _binRegistry state —
  /// the same one suggestPutAwayBin/checkPutAwayBin read and write — so
  /// a demo session's actual interactions (an auto-assigned split
  /// reserving a bin, a bin-first assignment occupying one) are visible
  /// here, not just static seed data.
  ///
  /// Field shape matches businessCentralDataSource.js's version as
  /// closely as each source's real data allows: binCode/isEmpty are
  /// meaningful for both. capacity/currentQty/occupantSku are demo-only
  /// (Business Central's /Bins endpoint has no capacity or contents
  /// field at all — see that adapter's own listBins) and simply absent
  /// from the Business Central response rather than faked here.
  /// locationCode is accepted for signature parity with
  /// businessCentralDataSource.js's listBins, but genuinely ignored here
  /// — the demo bin registry has no location association per bin at
  /// all (it's a flat capacity/occupancy map, not a real multi-location
  /// model), so there's nothing honest to filter by. Always returns
  /// every demo bin.
  async listBins(locationCode) {
    return {
      bins: Object.entries(this._binRegistry).map(([binCode, bin]) => ({
        binCode,
        isEmpty: !bin.occupantSku,
        occupantSku: bin.occupantSku || null,
        capacity: bin.capacity,
        currentQty: bin.currentQty,
      })),
    };
  }

  /// A pallet sits in ONE bin and its contents move together. Lookup by
  /// pallet number (case and spaces ignored). Returns the pallet with its
  /// bin, contents and movement history — see dataSource.interface.js.
  /// The legacy fields (palletId, lastLocation, lastTimestamp and
  /// name/sku/batch/units on each content line) are kept so older app
  /// builds still show something.
  async trackPallet(palletId) {
    const pallet = this._findPallet(palletId);
    if (!pallet) throw ApiError.notFound(`Pallet "${palletId}" was not found.`);
    return this._palletView(pallet);
  }

  /// Moves a whole pallet — every item on it — to another bin. Live, never
  /// queued. Payload: { palletNo, toBinCode }.
  async movePallet(payload) {
    const { palletNo, toBinCode } = payload || {};
    if (!palletNo || !toBinCode) throw ApiError.badRequest('palletNo and toBinCode are required.');
    const pallet = this._findPallet(palletNo);
    if (!pallet) throw ApiError.notFound(`Pallet "${palletNo}" was not found.`);
    const to = String(toBinCode).trim().toUpperCase();
    if (to === pallet.binCode.toUpperCase()) {
      throw ApiError.badRequest(`Pallet ${pallet.palletNo} is already in bin ${pallet.binCode}.`);
    }
    const bin = this._palletBins[to];
    if (!bin) throw ApiError.badRequest(`Bin "${to}" is not recognized at ${pallet.locationCode}.`);
    if (!bin.takesPallets) throw ApiError.badRequest(`Bin ${to} does not take pallets.`);
    const occupant = Object.values(this._pallets).find((p) => p.binCode.toUpperCase() === to);
    if (occupant && bin.maxPallets <= 1) {
      throw ApiError.badRequest(`Bin ${to} already holds pallet ${occupant.palletNo}.`);
    }
    const from = pallet.binCode;
    pallet.history.unshift({ at: new Date().toISOString(), fromBinCode: from, toBinCode: to, by: payload.by || null });
    pallet.binCode = to;
    pallet.zoneCode = bin.zoneCode;
    pallet.lastMovedAt = new Date().toISOString();
    return { ok: true, fromBinCode: from, pallet: this._palletView(pallet) };
  }

  _findPallet(id) {
    const key = String(id || '').trim().toUpperCase();
    return Object.values(this._pallets).find((p) => p.palletNo.toUpperCase() === key) || null;
  }

  _palletView(p) {
    const contents = p.contents.map((c) => ({
      ...c,
      // legacy shape
      name: c.description,
      sku: c.itemNo,
      batch: c.lotNo || '',
      units: c.qty,
    }));
    return {
      palletNo: p.palletNo,
      binCode: p.binCode,
      zoneCode: p.zoneCode,
      locationCode: p.locationCode,
      status: p.status,
      lastMovedAt: p.lastMovedAt,
      contents,
      history: p.history,
      // legacy shape
      palletId: p.palletNo,
      lastLocation: `${p.binCode}${p.zoneCode ? ` · Zone ${p.zoneCode}` : ''}`,
      lastTimestamp: p.lastMovedAt,
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
    return { documents: Object.values(this._transferDocs).map((d) => this._transferView(d)) };
  }

  async getTransferDocument(docId) {
    const doc = this._transferDocs[docId];
    if (!doc) throw ApiError.notFound(`Transfer document "${docId}" not found — nothing left to transfer.`);
    return this._transferView(doc);
  }

  /// A transfer as the app sees it. Every line carries its own id, its
  /// tracking (lot / serial), qty = what is still outstanding (registered
  /// units are gone), qtyHandled = registered so far, and qtyToHandle =
  /// saved and not registered yet (Update / Partial Transfer).
  _transferView(doc) {
    const saved = doc._saved || {};
    const savedOn = (lineId) => Object.values(saved[lineId] || {}).reduce((a, q) => a + q, 0);
    const items = doc.items.map((l) => ({ ...l, qtyToHandle: savedOn(l.lineId) }));
    const anyActivity = items.some((l) => l.qtyToHandle > 0 || (l.qtyHandled || 0) > 0);
    return { ...stripInternal(doc), status: anyActivity ? 'inProgress' : 'assigned', items };
  }

  /// UPDATE / PARTIAL TRANSFER — saves taken-and-placed units without
  /// registering (Business Central keeps them as Qty. to Handle). Payload:
  ///   { docId, register?: false, entries: [{ lineId, sku, fromBin, toBin,
  ///     qty, lotNo?, serialNo?, cumulative? }] }
  /// All-or-nothing, like Business Central's batch scan: every entry is
  /// checked before any is applied. [cumulative] is what the device has
  /// saved on that line and TO bin including this entry — an entry whose
  /// cumulative is already held is skipped, so a retry after a lost
  /// response never double-counts.
  async saveTransfer(payload) {
    const { docId, entries } = payload || {};
    const doc = this._transferDocs[docId];
    if (!doc) throw ApiError.notFound(`Transfer document "${docId}" not found.`);
    if (!Array.isArray(entries) || entries.length === 0) throw ApiError.badRequest('entries must be a non-empty array.');

    doc._saved = doc._saved || {};
    doc._held = doc._held || {};
    const planned = {};
    const apply = [];
    const problems = [];
    entries.forEach((e, i) => {
      const n = i + 1;
      const line = doc.items.find((l) => l.lineId === e.lineId);
      const qty = Number(e.qty);
      const toBin = String(e.toBin || '').trim().toUpperCase();
      if (!line) return problems.push(`Entry ${n}: line ${e.lineId} is not on ${docId}`);
      if (!(qty > 0)) return problems.push(`Entry ${n}: quantity must be greater than zero`);
      if (!toBin || !this._binRegistry[toBin]) return problems.push(`Entry ${n}: bin "${e.toBin}" does not exist`);
      if (String(e.fromBin || '').trim().toUpperCase() !== line.sourceBinCode.toUpperCase()) {
        return problems.push(`Entry ${n}: ${line.sku} is taken from ${line.sourceBinCode}, not ${e.fromBin}`);
      }
      if (line.isLotTracked && (e.lotNo || '') !== line.lotNo) return problems.push(`Entry ${n}: lot "${e.lotNo || ''}" does not match ${line.lotNo}`);
      if (line.isSerialTracked && (e.serialNo || '') !== line.serialNo) {
        return problems.push(`Entry ${n}: serial "${e.serialNo || ''}" does not match ${line.serialNo}`);
      }
      const heldKey = `${line.lineId}|${toBin}`;
      if (e.cumulative != null && (doc._held[heldKey] || 0) >= Number(e.cumulative)) return; // already applied
      const lineTotal = Object.values(doc._saved[line.lineId] || {}).reduce((a, q) => a + q, 0) + (planned[line.lineId] || 0) + qty;
      if (lineTotal > line.qty) return problems.push(`Entry ${n}: ${lineTotal} saved would exceed the ${line.qty} outstanding on ${line.sku}`);
      planned[line.lineId] = (planned[line.lineId] || 0) + qty;
      apply.push({ line, toBin, qty, heldKey });
    });
    if (problems.length) {
      throw ApiError.badRequest(`Processed ${entries.length - problems.length} entr${entries.length - problems.length === 1 ? 'y' : 'ies'}, skipped ${problems.length}: ${problems.join('; ')}. Nothing was saved.`);
    }
    for (const a of apply) {
      const byBin = (doc._saved[a.line.lineId] = doc._saved[a.line.lineId] || {});
      byBin[a.toBin] = (byBin[a.toBin] || 0) + a.qty;
      doc._held[a.heldKey] = (doc._held[a.heldKey] || 0) + a.qty;
    }
    return { ok: true, saved: apply.length, skipped: entries.length - apply.length, registerAttempted: false, registered: false, registerError: null };
  }

  /// REGISTER TRANSFER / PARTIAL REGISTER — posts what is saved. [expected]
  /// is what the device saved and has not registered: [{ lineId, toBin,
  /// qty }]. When the saved quantities here differ, nothing is posted
  /// (409 TRANSFER_QTY_MISMATCH) — the same safety check as Register Pick.
  /// Posted units leave the FROM bin, arrive in the TO bin, and come off
  /// the line; a line with nothing outstanding is removed, and a transfer
  /// with no lines left is gone (fullyRegistered: true).
  async registerTransfer(payload) {
    const { docId, expected } = payload || {};
    const doc = this._transferDocs[docId];
    if (!doc) throw ApiError.notFound(`Transfer document "${docId}" not found.`);
    const saved = doc._saved || {};
    const flat = {};
    for (const [lineId, byBin] of Object.entries(saved)) {
      for (const [bin, q] of Object.entries(byBin)) if (q > 0) flat[`${lineId}|${bin}`] = q;
    }
    if (Object.keys(flat).length === 0) throw ApiError.badRequest(`Nothing is saved on ${docId} to register.`);

    if (Array.isArray(expected)) {
      const want = {};
      for (const e of expected) {
        const k = `${e.lineId}|${String(e.toBin || '').trim().toUpperCase()}`;
        want[k] = (want[k] || 0) + Number(e.qty || 0);
      }
      const problems = [];
      for (const k of new Set([...Object.keys(want), ...Object.keys(flat)])) {
        if ((want[k] || 0) !== (flat[k] || 0)) {
          const [lineId, bin] = k.split('|');
          const line = doc.items.find((l) => l.lineId === lineId);
          problems.push(`${line ? line.sku : lineId} to ${bin}: device ${want[k] || 0}, server ${flat[k] || 0}`);
        }
      }
      if (problems.length) {
        throw ApiError.conflict(`Register stopped — nothing was posted. Saved quantities do not match: ${problems.join('; ')}.`, 'TRANSFER_QTY_MISMATCH');
      }
    }

    let posted = 0;
    for (const line of doc.items) {
      const byBin = saved[line.lineId] || {};
      for (const [bin, q] of Object.entries(byBin)) {
        if (!(q > 0)) continue;
        line.qty -= q;
        line.qtyHandled = (line.qtyHandled || 0) + q;
        posted += q;
        const from = this._binRegistry[line.sourceBinCode.toUpperCase()];
        if (from && from.occupantSku === line.sku) {
          from.currentQty = Math.max(0, from.currentQty - q);
          if (from.currentQty === 0) from.occupantSku = null;
        }
        const to = this._binRegistry[bin];
        if (to) {
          to.currentQty += q;
          if (!to.occupantSku) to.occupantSku = line.sku;
        }
      }
    }
    doc._saved = {};
    doc._held = {};
    doc.items = doc.items.filter((l) => l.qty > 0);
    const fullyRegistered = doc.items.length === 0;
    if (fullyRegistered) delete this._transferDocs[docId];
    return { ok: true, registered: true, postedQty: posted, fullyRegistered };
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
  const { _confirmed, _confirmedQty, _scanLogs, _saved, _held, ...rest } = doc;
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
  // Every line has its own id (a Business Central movement line would carry
  // its SystemId), its tracking and qty = outstanding. Take from
  // sourceBinCode, place into destinationBinCode.
  const line = (lineId, sku, description, qty, sourceBinCode, destinationBinCode, extra = {}) => ({
    lineId,
    sku,
    description,
    qty,
    qtyHandled: 0,
    uom: 'PCS',
    sourceBinCode,
    destinationBinCode,
    lotNo: '',
    serialNo: '',
    isLotTracked: false,
    isSerialTracked: false,
    scannable: true,
    ...extra,
  });
  return {
    'TR-00301': {
      docId: 'TR-00301',
      status: 'assigned',
      // Many-to-one: two small bins of the same item consolidating into one.
      items: [
        line('TR301-10000', 'SKU-BOLT-M6', 'Hex Bolt, M6 x 20mm', 18, 'A-05-01', 'C-02-01'),
        line('TR301-20000', 'SKU-BOLT-M6', 'Hex Bolt, M6 x 20mm', 6, 'A-05-02', 'C-02-01'),
      ],
    },
    'TR-00302': {
      docId: 'TR-00302',
      status: 'assigned',
      // One-to-many: one source bin split across two TO bins.
      items: [
        line('TR302-10000', 'SKU-NAIL-2IN', 'Finish Nail, 2 inch', 15, 'B-01-01', 'RCV-C2'),
        line('TR302-20000', 'SKU-NAIL-2IN', 'Finish Nail, 2 inch', 9, 'B-01-01', 'REPAIR-STAGING'),
      ],
    },
    'TR-00303': {
      docId: 'TR-00303',
      status: 'assigned',
      items: [line('TR303-10000', 'SKU-CLIP-RET', 'Retaining Clip', 9, 'B-03-04', 'REPAIR-STAGING')],
    },
    'TR-00304': {
      docId: 'TR-00304',
      status: 'assigned',
      // Lot-tracked (scan the lot number, or the item after the lot) and
      // serial-tracked lines (scan each serial number).
      items: [
        line('TR304-10000', 'ITM_KL_0102', 'Sodium Chloride Infusion BP 0.9% W/V 500ML', 12, 'RCV-B2', 'RCV-A2', { lotNo: 'PFL25226', isLotTracked: true, uom: 'BTL' }),
        line('TR304-20000', 'ITM_KL_0148', 'Service Connection Wooden LV Poles 10 Meters', 1, 'RCV-B1', 'C-02-01', {
          lotNo: 'BC63/FEB-26',
          serialNo: 'NP02815',
          isLotTracked: true,
          isSerialTracked: true,
        }),
        line('TR304-30000', 'ITM_KL_0148', 'Service Connection Wooden LV Poles 10 Meters', 1, 'RCV-B1', 'C-02-01', {
          lotNo: 'BC63/FEB-26',
          serialNo: 'NP02817',
          isLotTracked: true,
          isSerialTracked: true,
        }),
      ],
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
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 4, sourceBinCode: 'A-05-01', destinationBinCode: 'QZ-DAMAGED', reasonCode: 'damaged', reasonNote: 'Crushed carton on receipt' },
        { sku: 'SKU-BOLT-M6', description: 'Hex Bolt, M6 x 20mm', qty: 2, sourceBinCode: 'A-05-02', destinationBinCode: 'QZ-DAMAGED', reasonCode: 'damaged', reasonNote: null },
      ],
    },
    'QT-00502': {
      docId: 'QT-00502',
      status: 'assigned',
      items: [
        { sku: 'SKU-CLIP-RET', description: 'Retaining Clip', qty: 9, sourceBinCode: 'B-03-04', destinationBinCode: 'QZ-HOLD', reasonCode: 'qualityHold', reasonNote: 'Supplier recall check' },
      ],
    },
    'QT-00503': {
      docId: 'QT-00503',
      status: 'assigned',
      items: [
        { sku: 'SKU-NAIL-2IN', description: 'Wire Nail, 2 inch', qty: 12, sourceBinCode: 'B-01-01', destinationBinCode: 'QZ-HOLD', reasonCode: 'qualityHold', reasonNote: null },
      ],
    },
  };
}

function seedPallets() {
  const hour = 60 * 60 * 1000;
  const at = (h) => new Date(Date.now() - h * hour).toISOString();
  return {
    'PLT-0001': {
      palletNo: 'PLT-0001',
      binCode: 'A-01-01',
      zoneCode: 'S-ZONE-A',
      locationCode: '3PL-WH-BKL',
      status: 'In bin',
      lastMovedAt: at(5),
      contents: [
        { itemNo: 'ITM_KL_0112', description: 'Sodium Chloride Infusion BP 0.9% W/V 500ML', lotNo: 'PFL25180', serialNo: '', qty: 480, uom: 'BTL' },
        { itemNo: 'ITM_KL_0113', description: 'Glucose Intravenous Infusion BP5% W/V 500ML', lotNo: 'PL00001', serialNo: '', qty: 240, uom: 'BTL' },
      ],
      history: [
        { at: at(5), fromBinCode: 'RECEIVING-1-', toBinCode: 'A-01-01', by: 'JKUSIIMA' },
      ],
    },
    'PLT-0002': {
      palletNo: 'PLT-0002',
      binCode: 'B-02-03',
      zoneCode: 'S-ZONE-B',
      locationCode: '3PL-WH-BKL',
      status: 'In bin',
      lastMovedAt: at(26),
      contents: [
        { itemNo: 'ITM_KL_0150', description: 'Power Transformer 5MVA 132/33kV', lotNo: '', serialNo: '376909881', qty: 1, uom: 'PCS' },
        { itemNo: 'ITM_KL_0150', description: 'Power Transformer 5MVA 132/33kV', lotNo: '', serialNo: '376909888', qty: 1, uom: 'PCS' },
      ],
      history: [
        { at: at(26), fromBinCode: 'RECEIVING-1-', toBinCode: 'B-02-03', by: 'IAMPAIRE' },
      ],
    },
    'PLT-0003': {
      palletNo: 'PLT-0003',
      binCode: 'RECEIVING-1-',
      zoneCode: 'REC-ZONE',
      locationCode: '3PL-WH-BKL',
      status: 'In bin',
      lastMovedAt: at(1),
      contents: [
        { itemNo: 'ITM_KL_0128', description: 'Galvanized Wires', lotNo: '', serialNo: '', qty: 200, uom: 'ROLL' },
      ],
      history: [],
    },
  };
}

module.exports = new DemoDataSource();
module.exports.DemoDataSource = DemoDataSource;