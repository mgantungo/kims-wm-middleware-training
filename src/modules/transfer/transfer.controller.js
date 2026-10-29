// src/modules/transfer/transfer.controller.js
const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function listDocuments(req, res) {
  const result = await dataSource.getTransferDocuments();
  res.json(result);
}

async function getDocument(req, res) {
  const doc = await dataSource.getTransferDocument(req.params.docId);
  res.json(doc);
}

async function validateBin(req, res) {
  const { docId, binCode, sku, qty } = req.body || {};
  if (!docId || !binCode || !sku || qty == null) {
    throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
  }
  // Split-only, live, never outbox-queued — the operator is standing at
  // a candidate bin waiting on accept/reject, same reasoning as Put
  // Away's validate-bin.
  const result = await dataSource.validateTransferSplitBin({ docId, binCode, sku, qty });
  res.status(200).json(result);
}

async function suggestBin(req, res) {
  const { docId, sku, qty, excludeBinCode } = req.body || {};
  if (!docId || !sku || qty == null) {
    throw ApiError.badRequest('docId, sku, and qty are required.');
  }
  const result = await dataSource.suggestTransferSplitBin({ docId, sku, qty, excludeBinCode });
  res.status(200).json(result);
}

async function confirmItem(req, res) {
  const { docId, sku, sourceBinCode, destinationBinCode, qty, scanLog } = req.body || {};
  if (!docId || !sku || !sourceBinCode || !destinationBinCode || qty == null) {
    throw ApiError.badRequest('docId, sku, sourceBinCode, destinationBinCode, and qty are required.');
  }
  // Local-first / outbox-queued on the client, same convention as
  // confirmPutAwayItem — the source and destination bins were both
  // already decided by Business Central when the document was assigned,
  // so unlike the old ad-hoc design there's nothing left to validate live
  // here; the operator's scans are a physical confirmation, not a
  // judgment call the server needs to approve in real time.
  const result = await dataSource.confirmTransferItem({ docId, sku, sourceBinCode, destinationBinCode, qty, scanLog });
  res.status(201).json(result);
}

/// UPDATE / PARTIAL TRANSFER — saves without registering. Replayed from
/// the app's outbox, so it must be safe to resend: every entry carries
/// `cumulative` (see dataSource.saveTransfer).
async function saveBatch(req, res) {
  const { docId, bcTransferId, entries, register } = req.body || {};
  if (!docId || !Array.isArray(entries) || entries.length === 0) {
    throw ApiError.badRequest('docId and a non-empty entries array are required.');
  }
  if (register === true) {
    throw ApiError.badRequest('A save never registers — call POST /transfer/register after it.');
  }
  const result = await dataSource.saveTransfer({ docId, bcTransferId, entries });
  res.status(200).json(result);
}

/// REGISTER TRANSFER / PARTIAL REGISTER — live, never queued. `expected`
/// is what the device saved and has not registered; a mismatch posts
/// nothing (409).
async function register(req, res) {
  const { docId, bcTransferId, partial, expected } = req.body || {};
  if (!docId) throw ApiError.badRequest('docId is required.');
  const result = await dataSource.registerTransfer({ docId, bcTransferId, partial: partial === true, expected });
  res.status(200).json(result);
}

module.exports = { listDocuments, getDocument, validateBin, suggestBin, confirmItem, saveBatch, register };