const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./inquiry.controller');

const router = express.Router();

// GET /inquiry/item?q=...
router.get('/item', asyncHandler(controller.item));
// GET /inquiry/bin?code=...
router.get('/bin', asyncHandler(controller.bin));
// GET /inquiry/pallet?id=...
router.get('/pallet', asyncHandler(controller.pallet));

module.exports = router;
