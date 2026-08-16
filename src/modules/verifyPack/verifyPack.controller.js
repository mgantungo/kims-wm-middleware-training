const dataSource = require('../../data/dataSourceFactory');
const verifyAuditStore = require('../../data/verifyAuditStore');
const ApiError = require('../../utils/apiError');

async function listUnverified(req, res) {
  const result = await dataSource.getUnverifiedPicks();
  res.json(result);
}

async function getPick(req, res) {
  const pick = await dataSource.getVerifyPick(req.params.orderId);
  res.json(pick);
}

async function submit(req, res) {
  const { orderId, items, packages } = req.body || {};
  if (!orderId || !Array.isArray(items)) {
    throw ApiError.badRequest('orderId and items are required.');
  }

  // Recorded BEFORE the adapter call: DemoDataSource deletes the pick from
  // its unverified list as part of submitVerifyPack, so anything not
  // captured here first is gone the moment that call returns. Each item
  // may carry its own scanLog ({ sequence, scannedAt }[]) — the per-unit
  // accepted-scan timeline for that item, same shape and purpose as the
  // scanLog on /put-away/confirm and /pick/confirm. Verify does this
  // per-item rather than once for the whole submission because a single
  // verify pass covers several items at once, and a loose/misplaced item
  // found mid-batch needs to be traceable to which specific item's scan
  // sequence it turned up in.
  verifyAuditStore.append({
    orderId,
    operatorId: req.user.username,
    items,
    packages: packages || [],
    submittedAt: new Date().toISOString(),
  });

  const result = await dataSource.submitVerifyPack({ orderId, items, packages: packages || [] });
  res.status(201).json(result);
}

module.exports = { listUnverified, getPick, submit };
