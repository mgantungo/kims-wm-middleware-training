const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function confirmLoad(req, res) {
  const { orderRef, vehicleId, driverName, pallets } = req.body || {};
  if (!orderRef || !vehicleId) {
    throw ApiError.badRequest('orderRef and vehicleId are required.');
  }
  const result = await dataSource.confirmShipLoad({ orderRef, vehicleId, driverName, pallets: pallets || [] });
  res.status(201).json(result);
}

module.exports = { confirmLoad };
