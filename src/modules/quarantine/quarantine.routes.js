const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./quarantine.controller');

const router = express.Router();

// GET /quarantine/source-bin/:binCode — same ad-hoc entry point as
// Item Transfer: what's physically in this bin right now.
router.get('/source-bin/:binCode', asyncHandler(controller.getSourceBin));

// POST /quarantine/validate-bin — is this destination bin a recognized
// quarantine zone with room for [qty]? Live, blocking, never queued.
router.post('/validate-bin', asyncHandler(controller.validateBin));

// POST /quarantine/confirm — records the movement. UNLIKE Item Transfer's
// /transfer/confirm, this is called and awaited live by the app — it is
// NEVER replayed from the client's offline outbox, because a quarantine
// confirm is a real stock movement the operator is standing there waiting
// on Business Central to accept.
router.post('/confirm', asyncHandler(controller.confirmQuarantine));

module.exports = router;