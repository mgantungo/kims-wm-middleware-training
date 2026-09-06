const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

const VALID_REASON_CODES = ['damaged', 'expired', 'qualityHold', 'other'];

async function getSourceBin(req, res) {
  const { binCode } = req.params;
  if (!binCode) throw ApiError.badRequest('binCode is required.');
  const result = await dataSource.getQuarantineSourceBin(binCode);
  res.json(result);
}

async function validateBin(req, res) {
  const { sourceBinCode, destinationBinCode, sku, qty } = req.body || {};
  if (!sourceBinCode || !destinationBinCode || !sku || qty == null) {
    throw ApiError.badRequest('sourceBinCode, destinationBinCode, sku, and qty are required.');
  }
  const result = await dataSource.validateQuarantineBin({ sourceBinCode, destinationBinCode, sku, qty });
  res.status(200).json(result);
}

async function confirmQuarantine(req, res) {
  const { sourceBinCode, destinationBinCode, sku, qty, reasonCode, reasonNote, scanLog } = req.body || {};
  if (!sourceBinCode || !destinationBinCode || !sku || qty == null) {
    throw ApiError.badRequest('sourceBinCode, destinationBinCode, sku, and qty are required.');
  }
  // Reason IS required for Quarantine — unlike Item Transfer, where it's
  // optional. This is the one field-level difference in an otherwise
  // identical request shape.
  if (!reasonCode || !VALID_REASON_CODES.includes(reasonCode)) {
    throw ApiError.badRequest(`reasonCode is required and must be one of: ${VALID_REASON_CODES.join(', ')}.`);
  }
  if (reasonCode === 'other' && !reasonNote) {
    throw ApiError.badRequest('reasonNote is required when reasonCode is "other".');
  }

  const result = await dataSource.confirmQuarantine({
    sourceBinCode,
    destinationBinCode,
    sku,
    qty,
    reasonCode,
    reasonNote: reasonNote || null,
    scanLog,
  });
  res.status(201).json(result);
}

module.exports = { getSourceBin, validateBin, confirmQuarantine };