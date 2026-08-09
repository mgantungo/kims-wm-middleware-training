const dataSource = require('../../data/dataSourceFactory');
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
  const result = await dataSource.submitVerifyPack({ orderId, items, packages: packages || [] });
  res.status(201).json(result);
}

module.exports = { listUnverified, getPick, submit };
