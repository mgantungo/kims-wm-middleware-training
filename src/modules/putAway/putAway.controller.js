// src/modules/putAway/putAway.controller.js
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
  const { docId, sku, location, qty, scanLog, bcPutAwayId, bcLineId } = req.body || {};
  if (!docId || !sku || !location || qty == null) {
    throw ApiError.badRequest('docId, sku, location, and qty are required.');
  }
  // scanLog is optional and additive: the per-unit accepted-scan timeline
  // ({ sequence, scannedAt }[]) behind `qty`, for audit purposes. Its
  // absence (older app builds, or a line confirmed without unit-by-unit
  // scanning) doesn't affect the existing confirm behaviour.
  //
  // bcPutAwayId/bcLineId are also optional and additive — present only
  // when this line was originally read from Business Central (see
  // businessCentralDataSource.js's _mapPutAway). The demo adapter ignores
  // them entirely; the Business Central adapter requires them to address
  // its PATCH endpoint and throws a clear error if they're missing rather
  // than confirming against the wrong line.
  const result = await dataSource.confirmPutAwayItem({ docId, sku, location, qty, scanLog, bcPutAwayId, bcLineId });
  res.status(201).json(result);
}

async function validateBin(req, res) {
  const { docId, binCode, sku, qty } = req.body || {};
  if (!docId || !binCode || !sku || qty == null) {
    throw ApiError.badRequest('docId, binCode, sku, and qty are required.');
  }
  // Not a scan confirmation and not outbox material — the operator is
  // waiting live on Business Central's accept/reject before scanning
  // continues, so this call is synchronous and never queued.
  const result = await dataSource.validatePutAwayBin({ docId, binCode, sku, qty });
  res.status(200).json(result);
}

async function suggestBin(req, res) {
  const { docId, sku, qty, excludeBinCodes } = req.body || {};
  if (!docId || !sku || qty == null) {
    throw ApiError.badRequest('docId, sku, and qty are required.');
  }
  // Same "live and blocking, never queued" reasoning as validateBin — the
  // operator is watching the split-bin animation waiting on this to
  // resolve, not something the offline outbox should ever replay.
  // excludeBinCodes is a list now, not a single code — the client sends
  // every bin already belonging to this document, not just the one line
  // came up short, so an auto-assigned remainder never lands somewhere
  // already tied to this same task.
  const result = await dataSource.suggestPutAwayBin({ docId, sku, qty, excludeBinCodes });
  res.status(200).json(result);
}

async function checkBin(req, res) {
  const { binCode, sku, locationCode } = req.body || {};
  if (!binCode || !sku) {
    throw ApiError.badRequest('binCode and sku are required.');
  }
  // Live and blocking, same reasoning as validateBin/suggestBin — the
  // operator is standing at a bin they've chosen themselves (for a line
  // Business Central left unassigned) waiting on accept/reject before
  // they can start scanning items into it. sku is required here even
  // though no units have been scanned yet — the app already knows which
  // LINE it's assigning a bin for, and the middleware needs it to tell
  // "empty or already holds this same item" apart from "holds something
  // unrelated." locationCode is optional but important against real
  // Business Central data — without it, a same-named bin in a different
  // BC location can come back "available" here and then fail Business
  // Central's own PATCH .../putAwayLines validation once actually
  // confirmed. See businessCentralDataSource.js's checkPutAwayBin.
  const result = await dataSource.checkPutAwayBin({ binCode, sku, locationCode });
  res.status(200).json(result);
}

async function register(req, res) {
  const { docId, bcPutAwayId } = req.body || {};
  if (!docId || !bcPutAwayId) {
    throw ApiError.badRequest('docId and bcPutAwayId are required.');
  }
  // Replayed from the sync outbox (see PutAwayRepository's
  // putAwayRegister handler) — unlike confirmItem's own outbox entries,
  // there's no operator standing here waiting on this specific call, so
  // it genuinely benefits from offline resilience rather than needing a
  // live/blocking round trip.
  const result = await dataSource.registerPutAway({ docId, bcPutAwayId });
  res.status(200).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem, validateBin, suggestBin, checkBin, register };