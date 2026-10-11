// src/modules/inquiry/inquiry.routes.js
const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./inquiry.controller');

const router = express.Router();

// GET /inquiry/item?q=...[&locationCode=...] — q may be a barcode, an item
// number or part of an item name (BC Section 2.3.1 itemInquiries)
router.get('/item', asyncHandler(controller.item));
// GET /inquiry/bin?code=...[&locationCode=...] — code may be a bin code
// or a bin barcode (whatever the scanner read)
router.get('/bin', asyncHandler(controller.bin));
// GET /inquiry/bins — the full bins list ("browse all", not a single lookup)
router.get('/bins', asyncHandler(controller.bins));
// GET /inquiry/pallet?id=...
router.get('/pallet', asyncHandler(controller.pallet));

module.exports = router;