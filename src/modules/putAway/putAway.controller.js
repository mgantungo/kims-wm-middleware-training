// src/modules/putAway/putAway.controller.js
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

async function validateBin(req, res) {
  const { docId, binCode, sku, qty } = req.body || {};
  if (!docId || !binCode || !sku || qty == null) {
    throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
  }
  // Not a scan confirmation and not outbox material — the operator is
  // waiting live on Business Central's accept/reject before scanning
  // continues, so this call is synchronous and never queued.
  const result = await dataSource.validatePutAwayBin({ docId, binCode, sku, qty });
  res.status(200).json(result);
}

async function suggestBin(req, res) {
  const { docId, sku, qty, excludeBinCodes } = req.body || {};
  if (!docId || !sku || qty == null) {
    throw ApiError.badRequest('docId, sku, and qty are required.');
  }
  // Same "live and blocking, never queued" reasoning as validateBin — the
  // operator is watching the split-bin animation waiting on this to
  // resolve, not something the offline outbox should ever replay.
  // excludeBinCodes is a list now, not a single code — the client sends
  // every bin already belonging to this document, not just the one line
  // came up short, so an auto-assigned remainder never lands somewhere
  // already tied to this same task.
  const result = await dataSource.suggestPutAwayBin({ docId, sku, qty, excludeBinCodes });
  res.status(200).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem, validateBin, suggestBin };