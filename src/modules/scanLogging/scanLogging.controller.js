const scanExceptionStore = require('../../data/scanExceptionStore');
const verifyAuditStore = require('../../data/verifyAuditStore');
const ApiError = require('../../utils/apiError');

const VALID_FLOW_TYPES = ['put_away', 'pick', 'verify'];
const VALID_STATUSES = [
  'rejected_item_mismatch',
  'rejected_location_mismatch',
  'rejected_unknown_item',
  'rejected_target_met',
];

/**
 * POST /scan-logging/exceptions
 *
 * Pushed by the device the moment a scan is rejected as a mismatch —
 * independent of whether the operator ever confirms the document line it
 * belongs to. Authenticated the same way every other device endpoint is
 * (requireAuth, mounted in app.js), not admin-gated: this is a device
 * writing its own activity, same trust level as confirming a put-away or
 * pick line.
 *
 * Field names deliberately match /put-away/confirm and /pick/confirm
 * (docId, sku) rather than inventing new ones — this API identifies a line
 * the same way everywhere. `sku` is the expected item for the line being
 * worked; for a rejected_unknown_item scan there may be no real line match,
 * in which case `sku` is whatever the screen had loaded as its current
 * target and `scannedRawValue` is what the scan actually decoded to.
 */
async function logException(req, res) {
  const {
    localId, docId, flowType, status,
    deviceId, scannedAt, sku,
    scannedRawValue, expectedLocation, scannedLocation,
  } = req.body || {};

  if (!localId || !docId || !flowType || !status || !deviceId || !scannedAt || !sku) {
    throw ApiError.badRequest(
      'localId, docId, flowType, status, deviceId, scannedAt, and sku are required.',
    );
  }
  if (!VALID_FLOW_TYPES.includes(flowType)) {
    throw ApiError.badRequest(`flowType must be one of: ${VALID_FLOW_TYPES.join(', ')}.`);
  }
  if (!VALID_STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
  }

  const stored = scanExceptionStore.append({
    localId,
    docId,
    flowType,
    status,
    // req.user comes from requireAuth — trust the token's identity for
    // who scanned, not whatever the request body claims.
    operatorId: req.user.username,
    deviceId,
    scannedAt,
    sku,
    scannedRawValue: scannedRawValue || null,
    expectedLocation: expectedLocation || null,
    scannedLocation: scannedLocation || null,
  });

  res.status(201).json({ localId: stored.localId, accepted: true });
}

/**
 * GET /scan-logging/exceptions
 * Admin-only (requireAdmin, mounted in the route file). Optional filters:
 * ?docId=...&status=...&limit=...&offset=...
 */
async function listExceptions(req, res) {
  const { docId, status, limit, offset } = req.query;
  const records = scanExceptionStore.query({
    docId,
    status,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json({ records });
}

/**
 * GET /scan-logging/verify-submissions
 * Admin-only. Optional filters: ?orderId=...&limit=...&offset=...
 * Each record is a full /pick/verify/submit call, including every item's
 * scanLog — the durable trail for tracing a loose or misplaced item found
 * mid-batch back to when and in what sequence it was scanned, even though
 * DemoDataSource removes the pick from the unverified list on submit.
 */
async function listVerifySubmissions(req, res) {
  const { orderId, limit, offset } = req.query;
  const records = verifyAuditStore.query({
    orderId,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json({ records });
}

module.exports = { logException, listExceptions, listVerifySubmissions };
