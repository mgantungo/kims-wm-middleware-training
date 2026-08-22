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
    // Kept alongside _confirmed rather than merged into the item itself —
    // like _confirmed, this is confirmation bookkeeping, not document data,
    // and stripInternal() already knows to drop keys prefixed with _.
    doc._scanLogs = doc._scanLogs || {};
    if (Array.isArray(scanLog)) doc._scanLogs[sku] = scanLog;
    doc.status = doc._confirmed.size >= doc.items.length ? 'complete' : 'inProgress';
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
    // In a real Business Central adapter this is where over/under-pick
    // quantity adjustments get posted. Here we just retire the pick from
    // the "unverified" list so it disappears from the list screen, mirroring
    // the prototype's return-to-list behaviour after completion.
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
    // Demo adapter ignores the query and always returns the seeded item —
    // enough to exercise the full UI without a real catalog behind it.
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
      items: [
        { sku: 'SKU-1001', description: '12oz Organic Coffee Beans', qty: 50, location: 'RCV-A1' },
        { sku: 'SKU-1002', description: 'Stainless Steel Mixing Bowl', qty: 20, location: 'RCV-A2' },
      ],
    },
    'PA-00123': {
      docId: 'PA-00123',
      sourceWarehouseReceipt: 'WHR-54321',
      status: 'assigned',
      items: [{ sku: 'SKU-2001', description: 'Cotton Packing Blankets', qty: 40, location: 'RCV-B1' }],
    },
    'PA-00124': {
      docId: 'PA-00124',
      sourceWarehouseReceipt: 'WHR-54322',
      status: 'assigned',
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
    // Deliberately larger/messier than the others, for testing the
    // walk-order Pick flow properly: 5 bins, 7 line items, 40 units total.
    // SKU-BOLT-M6 is split across THREE separate bins (A-05-01, A-05-02,
    // C-02-01) — the split-sku-across-bins scenario. A-05-01 and B-03-04
    // each carry two different skus in one bin — the multiple-items-in-
    // one-bin scenario. Walk order should come out sorted by bin address:
    // A-05-01, A-05-02, B-01-01, B-03-04, C-02-01.
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
