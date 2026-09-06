const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./transfer.controller');

const router = express.Router();

// GET /transfer/source-bin/:binCode — what's physically in a bin right now,
// available to move. Ad-hoc entry point: unlike Put Away/Pick, Transfer has
// no assigned "document" to select first — the operator starts by scanning
// whatever bin they're standing at.
router.get('/source-bin/:binCode', asyncHandler(controller.getSourceBin));

// POST /transfer/validate-bin — is this destination bin free to receive
// [qty] units of [sku]? Synchronous, never outbox-queued: the operator is
// standing at the destination waiting on a live accept/reject, same
// reasoning as PUT-AWAY's /put-away/validate-bin.
router.post('/validate-bin', asyncHandler(controller.validateBin));

// POST /transfer/confirm — records one source→destination movement.
// Local-first / outbox-queued on the client, same as /put-away/confirm.
router.post('/confirm', asyncHandler(controller.confirmTransfer));

module.exports = router;