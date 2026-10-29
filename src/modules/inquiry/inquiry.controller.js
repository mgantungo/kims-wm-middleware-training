// src/modules/inquiry/inquiry.controller.js
const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');
const { assertVisible } = require('../../utils/locationAccess');

async function item(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) throw ApiError.badRequest('Query parameter "q" is required.');
  // Same precedence as bin() below: the operator's own verified location
  // always wins; a client-supplied locationCode is only used when the
  // operator has none yet. Business Central returns the item's stock in
  // every location (Section 2.3.1); the adapter keeps only this one.
  const locationCode = (req.user && req.user.locationCode) || req.query.locationCode;
  const result = await dataSource.searchItem(q, { locationCode });
  res.json(result);
}

async function bin(req, res) {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
  if (!code) throw ApiError.badRequest('Query parameter "code" is required.');
  // Same precedence as bins() below: the operator's own verified
  // location always wins; a client-supplied locationCode is only used
  // when the operator has none yet. Passed INTO the lookup so Business
  // Central returns the bin at the operator's location — not whichever
  // same-coded bin it happened to list first, which assertVisible below
  // would then reject even though a valid bin exists here.
  const locationCode = (req.user && req.user.locationCode) || req.query.locationCode;
  const result = await dataSource.searchBin(code, { locationCode });
  // Kept as defence in depth. result.location (not .locationCode — see
  // locationAccess.js's doc on why searchBin and listBins use different
  // field names for the same concept). notFound, not forbidden — same
  // reasoning as putAway.controller.js's getDocument: an operator
  // outside this bin's location shouldn't learn that it exists elsewhere.
  assertVisible(result.location, req, () => {
    throw ApiError.notFound(`Bin "${code}" is not recognized.`);
  });
  res.json(result);
}

async function bins(req, res) {
  // The operator's own verified location always wins over whatever the
  // client asked for — a client-supplied locationCode is a convenience
  // for narrowing results, never a way to reach another location's bins.
  // Only falls back to the client's requested value (or none, i.e.
  // unfiltered) when the operator has no locationCode of their own yet —
  // the same backward-compatible gap every other location check in this
  // app allows, not a bypass.
  const locationCode = (req.user && req.user.locationCode) || req.query.locationCode;
  const result = await dataSource.listBins(locationCode);
  res.json(result);
}

async function pallet(req, res) {
  const id = req.query.id;
  if (!id) throw ApiError.badRequest('Query parameter "id" is required.');
  const result = await dataSource.trackPallet(id);
  res.json(result);
}

/// POST /inquiry/pallet/move — moves a whole pallet (everything on it) to
/// another bin. Live, never queued: the operator is standing at the new
/// bin. Body: { palletNo, toBinCode }.
async function movePallet(req, res) {
  const { palletNo, toBinCode } = req.body || {};
  if (!palletNo || !toBinCode) throw ApiError.badRequest('palletNo and toBinCode are required.');
  const by = req.user && (req.user.username || req.user.sub);
  const result = await dataSource.movePallet({ palletNo, toBinCode, by: by || null });
  res.json(result);
}

module.exports = { item, bin, bins, pallet, movePallet };