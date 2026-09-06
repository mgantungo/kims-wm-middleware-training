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
    };

    // Item descriptions, for bins whose sku doesn't already come attached
    // to one via a put-away/pick document line. Transfer's source-bin
    // lookup needs a human-readable description even for a bin that was
    // only ever populated by seed data or a prior transfer.
    this._itemDescriptions = {
      'SKU-1001': '12oz Organic Coffee Beans',
      'SKU-1002': 'Stainless Steel Mixing Bowl',
      'SKU-2001': 'Cotton Packing Blankets',
      'SKU-3001': 'Galvanized Steel Brackets',
      'SKU-BOLT-M6': 'Hex Bolt, M6 x 20mm',
      'SKU-WASH-M6': 'Flat Washer, M6',
      'SKU-NAIL-2IN': 'Finish Nail, 2 inch',
      'SKU-CLIP-RET': 'Retaining Clip',
      'SKU-SCREW-M4': 'Machine Screw, M4',
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
  async suggestPutAwayBin(payload) {
    const { docId, sku, qty, excludeBinCode } = payload || {};
    if (!docId || !sku || qty == null) {
      throw ApiError.badRequest('docId, sku, and qty are required.');
    }

    const excluded = excludeBinCode ? String(excludeBinCode).trim().toUpperCase() : null;
    const entries = Object.entries(this._binRegistry).filter(([code]) => code !== excluded);

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
  // Item Transfer
  // ------------------------------------------------------------------

  /// What's physically in [binCode] right now, per the shared bin
  /// registry (see constructor doc). An unrecognized or empty bin
  /// resolves to `items: []` — a normal response, not an error, since the
  /// operator scanning an unexpectedly-empty bin is a real floor scenario
  /// worth surfacing calmly rather than throwing.
  async getTransferSourceBin(binCode) {
    const normalized = String(binCode || '').trim().toUpperCase();
    const bin = this._binRegistry[normalized];
    if (!bin || !bin.occupantSku || bin.currentQty <= 0) {
      return { binCode: normalized, items: [] };
    }
    return {
      binCode: normalized,
      items: [
        {
          sku: bin.occupantSku,
          description: this._itemDescriptions[bin.occupantSku] || bin.occupantSku,
          availableQty: bin.currentQty,
        },
      ],
    };
  }

  /// A destination bin is accepted only if it has enough free capacity
  /// AND either holds nothing yet or already holds the same sku — mixing
  /// two different skus in one physical bin isn't something this
  /// warehouse's bins support, matching [suggestPutAwayBin]'s registry
  /// model.
  async validateTransferBin(payload) {
    const { destinationBinCode, sku, qty } = payload || {};
    const normalized = String(destinationBinCode).trim().toUpperCase();
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

  /// Records the actual movement: decrements the source bin, increments
  /// the destination — a real change to on-hand quantity, not a flag.
  /// Both bins must already exist in the registry (the operator can only
  /// have gotten here by successfully scanning a source with stock and a
  /// validated destination), so a missing bin here indicates a genuine
  /// data problem worth a 400 rather than silently no-opping.
  async confirmTransfer(payload) {
    const { sourceBinCode, destinationBinCode, sku, qty } = payload;
    const sourceCode = String(sourceBinCode).trim().toUpperCase();
    const destCode = String(destinationBinCode).trim().toUpperCase();

    const source = this._binRegistry[sourceCode];
    const destination = this._binRegistry[destCode];

    if (!source || source.occupantSku !== sku || source.currentQty < qty) {
      throw ApiError.badRequest(`Source bin "${sourceCode}" does not have ${qty} unit(s) of "${sku}" available.`);
    }
    if (!destination) {
      throw ApiError.badRequest(`Destination bin "${destCode}" is not recognized.`);
    }
    if (destination.occupantSku && destination.occupantSku !== sku) {
      throw ApiError.conflict(`Destination bin ${destCode} now holds a different item — re-validate before retrying.`);
    }
    if (destination.capacity - destination.currentQty < qty) {
      throw ApiError.conflict(`Destination bin ${destCode} no longer has enough free capacity — re-validate before retrying.`);
    }

    source.currentQty -= qty;
    if (source.currentQty <= 0) {
      source.currentQty = 0;
      source.occupantSku = null;
    }

    destination.currentQty += qty;
    if (!destination.occupantSku) destination.occupantSku = sku;

    return { ok: true };
  }
}

function stripInternal(doc) {
  const { _confirmed, _scanLogs, ...rest } = doc;
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

module.exports = new DemoDataSource();
module.exports.DemoDataSource = DemoDataSource;