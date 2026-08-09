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
  const { docId, sku, location, qty } = req.body || {};
  if (!docId || !sku || !location || qty == null) {
    throw ApiError.badRequest('docId, sku, location, and qty are required.');
  }
  const result = await dataSource.confirmPutAwayItem({ docId, sku, location, qty });
  res.status(201).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem };
