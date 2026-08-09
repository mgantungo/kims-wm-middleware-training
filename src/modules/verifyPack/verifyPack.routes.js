const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./verifyPack.controller');

const router = express.Router();

// POST /pick/verify/submit — declared BEFORE the /:orderId route so the
// literal "submit" segment never gets swallowed as a param value.
router.post('/submit', asyncHandler(controller.submit));
// GET /pick/verify
router.get('/', asyncHandler(controller.listUnverified));
// GET /pick/verify/:orderId
router.get('/:orderId', asyncHandler(controller.getPick));

module.exports = router;
