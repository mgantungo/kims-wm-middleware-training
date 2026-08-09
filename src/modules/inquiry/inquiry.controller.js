const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');

async function item(req, res) {
  const q = req.query.q;
  if (!q) throw ApiError.badRequest('Query parameter "q" is required.');
  const result = await dataSource.searchItem(q);
  res.json(result);
}

async function bin(req, res) {
  const code = req.query.code;
  if (!code) throw ApiError.badRequest('Query parameter "code" is required.');
  const result = await dataSource.searchBin(code);
  res.json(result);
}

async function pallet(req, res) {
  const id = req.query.id;
  if (!id) throw ApiError.badRequest('Query parameter "id" is required.');
  const result = await dataSource.trackPallet(id);
  res.json(result);
}

module.exports = { item, bin, pallet };
