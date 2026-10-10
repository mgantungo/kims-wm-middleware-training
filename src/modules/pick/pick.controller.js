// src/modules/pick/pick.controller.js
const dataSource = require('../../data/dataSourceFactory');
const ApiError = require('../../utils/apiError');
const { assertVisible, filterByLocation } = require('../../utils/locationAccess');

/**
 * Pick endpoints. Every call goes through `dataSource` (dataSourceFactory.js)
 * — in hybrid mode PICK_READ_SOURCE / PICK_CONFIRM_SOURCE decide whether it
 * reaches Business Central or demo data. See dataSource.interface.js for the
 * payload and response shapes, and businessCentralDataSource.js's Pick
 * section for how they map onto the KIMS-WM API doc (Sections 2.5, 2.9,
 * 2.10, 2.11).
 *
 * bcPickId / bcLineId (and lotNo / serialNo) are optional and additive, as
 * in Put Away: present only for a pick read from Business Central. The demo
 * adapter ignores them; the Business Central adapter requires the ids and
 * fails with a clear message if they are missing.
 */

async function listDocuments(req, res) {
  const result = await dataSource.getPickDocuments();
  // Same location scoping as Put Away — an operator only sees picks for
  // their own Business Central location (permissive when either side has
  // no location; see utils/locationAccess.js).
  res.json({ ...result, documents: filterByLocation(result.documents, req, (doc) => doc.locationCode) });
}

async function getDocument(req, res) {
  const doc = await dataSource.getPickDocument(req.params.docId);
  assertVisible(doc && doc.locationCode, req, () => {
    throw ApiError.notFound(`Pick document "${req.params.docId}" was not found.`);
  });
  res.json(doc);
}

/// POST /pick/confirm — one real-time scan (Business Central Section 2.9).
/// Business Central does not de-duplicate scans, so this is for live,
/// one-at-a-time scanning only; the app's batched whole-pick sync uses
/// /pick/confirm-batch.
async function confirmItem(req, res) {
  const { docId, sku, location, qty, scanLog, bcPickId, bcLineId, lotNo, serialNo } = req.body || {};
  if (!docId || !sku || !location || qty == null) {
    throw ApiError.badRequest('docId, sku, location, and qty are required.');
  }
  // scanLog is optional and additive — see putAway.controller.js for the
  // same field.
  const result = await dataSource.confirmPickItem({
    docId,
    sku,
    location,
    qty,
    scanLog,
    bcPickId,
    bcLineId,
    lotNo,
    serialNo,
  });
  res.status(201).json(result);
}

/// POST /pick/confirm-batch — the whole pick's scans in one call, then
/// Register (Business Central Sections 2.10 + 2.11). All-or-nothing on
/// Business Central's side. The response always reports Register's
/// outcome (registerAttempted / registered / registerError) rather than
/// failing the request over it, because the scans are already saved once
/// the batch succeeds — resending them would double-count.
async function confirmBatch(req, res) {
  const { docId, bcPickId, entries } = req.body || {};
  if (!docId || !Array.isArray(entries) || entries.length === 0) {
    throw ApiError.badRequest('docId and a non-empty entries array are required.');
  }
  for (const [i, entry] of entries.entries()) {
    if (!entry.sku || !entry.location || entry.qty == null) {
      throw ApiError.badRequest(`entries[${i}]: sku, location, and qty are all required.`);
    }
  }
  const result = await dataSource.confirmPickBatch({ docId, bcPickId, entries });
  res.status(201).json(result);
}

/// POST /pick/register — manual Register (Section 2.11), e.g. to retry
/// after confirm-batch reported registered: false. Partial registration is
/// allowed: unscanned quantity stays outstanding on the same pick.
async function register(req, res) {
  const { docId, bcPickId } = req.body || {};
  if (!docId) {
    throw ApiError.badRequest('docId is required.');
  }
  const result = await dataSource.registerPick({ docId, bcPickId });
  res.status(200).json(result);
}

module.exports = { listDocuments, getDocument, confirmItem, confirmBatch, register };
