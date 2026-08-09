const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./ship.controller');

const router = express.Router();

// POST /ship/confirm
router.post('/confirm', asyncHandler(controller.confirmLoad));

module.exports = router;
