const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./gatePass.controller');

const router = express.Router();

// POST /gate-pass/generate
router.post('/generate', asyncHandler(controller.generate));

module.exports = router;
