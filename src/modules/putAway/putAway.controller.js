const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function listDocuments(req, res) {
  const result = await dataSource.getPutAwayDocuments();
  res.json(result);
}

async function getDocument(req, res) {
  const doc = await dataSource.getPutAwayDocument(req.params.docId);
  res.json(doc);
}

async function confirmItem(req, res) {
  const { docId, sku, location, qty, scanLog } = req.body || {};
  if (!docId || !sku || !location || qty == null) {
    throw ApiError.badRequest('docId, sku, location, and qty are required.');
  }
  // scanLog is optional and additive: the per-unit accepted-scan timeline
  // ({ sequence, scannedAt }[]) behind `qty`, for audit purposes. Its
  // absence (older app builds, or a line confirmed without unit-by-unit
  // scanning) doesn't affect the existing confirm behaviour.
  const result = await dataSource.confirmPutAwayItem({ docId, sku, location, qty, scanLog });
  res.status(201).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem };
