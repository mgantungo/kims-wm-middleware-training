const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function generate(req, res) {
  const { shippingDoc, materialRequest, vehicle, palletCount } = req.body || {};
  if (!shippingDoc) {
    throw ApiError.badRequest('shippingDoc is required.');
  }
  const gatePass = await dataSource.generateGatePass({ shippingDoc, materialRequest, vehicle, palletCount });
  res.status(201).json(gatePass);
}

module.exports = { generate };
