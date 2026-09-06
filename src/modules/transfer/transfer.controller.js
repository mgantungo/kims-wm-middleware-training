const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function getSourceBin(req, res) {
  const { binCode } = req.params;
  if (!binCode) throw ApiError.badRequest('binCode is required.');
  const result = await dataSource.getTransferSourceBin(binCode);
  res.json(result);
}

async function validateBin(req, res) {
  const { sourceBinCode, destinationBinCode, sku, qty } = req.body || {};
  if (!sourceBinCode || !destinationBinCode || !sku || qty == null) {
    throw ApiError.badRequest('sourceBinCode, destinationBinCode, sku, and qty are required.');
  }
  if (destinationBinCode.trim().toUpperCase() === sourceBinCode.trim().toUpperCase()) {
    return res.status(200).json({ accepted: false, reason: 'Destination bin must be different from the source bin.' });
  }
  // Not outbox material — the operator is standing at the destination bin
  // waiting on a live accept/reject before scanning continues.
  const result = await dataSource.validateTransferBin({ sourceBinCode, destinationBinCode, sku, qty });
  res.status(200).json(result);
}

async function confirmTransfer(req, res) {
  const { sourceBinCode, destinationBinCode, sku, qty, reasonCode, reasonNote, scanLog } = req.body || {};
  if (!sourceBinCode || !destinationBinCode || !sku || qty == null) {
    throw ApiError.badRequest('sourceBinCode, destinationBinCode, sku, and qty are required.');
  }
  // reasonCode is optional (per product decision: Transfer's reason is
  // optional, unlike Quarantine's). scanLog is optional/additive, same
  // convention as confirmPutAwayItem.
  const result = await dataSource.confirmTransfer({
    sourceBinCode,
    destinationBinCode,
    sku,
    qty,
    reasonCode: reasonCode || null,
    reasonNote: reasonNote || null,
    scanLog,
  });
  res.status(201).json(result);
}

module.exports = { getSourceBin, validateBin, confirmTransfer };