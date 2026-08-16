const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function listDocuments(req, res) {
  const result = await dataSource.getPickDocuments();
  res.json(result);
}

async function getDocument(req, res) {
  const doc = await dataSource.getPickDocument(req.params.docId);
  res.json(doc);
}

async function confirmItem(req, res) {
  const { docId, sku, location, qty, scanLog } = req.body || {};
  if (!docId || !sku || !location || qty == null) {
    throw ApiError.badRequest('docId, sku, location, and qty are required.');
  }
  // scanLog is optional and additive — see putAway.controller.js for the
  // same field.
  const result = await dataSource.confirmPickItem({ docId, sku, location, qty, scanLog });
  res.status(201).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem };
