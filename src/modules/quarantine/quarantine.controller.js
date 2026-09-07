// src/modules/quarantine/quarantine.controller.js
const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function listDocuments(req, res) {
  const result = await dataSource.getQuarantineDocuments();
  res.json(result);
}

async function getDocument(req, res) {
  const doc = await dataSource.getQuarantineDocument(req.params.docId);
  res.json(doc);
}

async function validateBin(req, res) {
  const { docId, binCode, sku, qty } = req.body || {};
  if (!docId || !binCode || !sku || qty == null) {
    throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
  }
  const result = await dataSource.validateQuarantineSplitBin({ docId, binCode, sku, qty });
  res.status(200).json(result);
}

async function suggestBin(req, res) {
  const { docId, sku, qty, excludeBinCode } = req.body || {};
  if (!docId || !sku || qty == null) {
    throw ApiError.badRequest('docId, sku, and qty are required.');
  }
  const result = await dataSource.suggestQuarantineSplitBin({ docId, sku, qty, excludeBinCode });
  res.status(200).json(result);
}

async function confirmItem(req, res) {
  const { docId, sku, sourceBinCode, destinationBinCode, qty, scanLog } = req.body || {};
  if (!docId || !sku || !sourceBinCode || !destinationBinCode || qty == null) {
    throw ApiError.badRequest('docId, sku, sourceBinCode, destinationBinCode, and qty are required.');
  }
  // Local-first / outbox-queued on the client, same as confirmTransferItem
  // — Business Central already decided the source bin, destination
  // quarantine bin, and reason when the document was assigned, so this is
  // a physical confirmation of a pre-approved movement, not a live
  // judgment call the server needs to approve in real time.
  const result = await dataSource.confirmQuarantineItem({ docId, sku, sourceBinCode, destinationBinCode, qty, scanLog });
  res.status(201).json(result);
}

module.exports = { listDocuments, getDocument, validateBin, suggestBin, confirmItem };