// src/modules/transfer/transfer.routes.js
const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./transfer.controller');

const router = express.Router();

// GET /transfer/documents
router.get('/documents', asyncHandler(controller.listDocuments));
// GET /transfer/documents/:docId
router.get('/documents/:docId', asyncHandler(controller.getDocument));
// POST /transfer/validate-bin — split-only: the operator has ALREADY
// arrived at the Business Central-assigned destination and found it
// physically short of room. This asks whether an operator-scanned
// candidate bin can take the remainder. Never used to decide a line's
// original destination — that's always pre-assigned (see getDocument).
router.post('/validate-bin', asyncHandler(controller.validateBin));
// POST /transfer/suggest-bin — same split-only scope as validate-bin, but
// Business Central picks the remainder's bin itself (auto-assign) rather
// than judging one the operator scanned.
router.post('/suggest-bin', asyncHandler(controller.suggestBin));
// POST /transfer/confirm — one line, saved and done (older app builds).
router.post('/confirm', asyncHandler(controller.confirmItem));
// POST /transfer/save — Update / Partial Transfer: taken-and-placed units
// saved without registering. Safe to resend (cumulative per entry).
router.post('/save', asyncHandler(controller.saveBatch));
// POST /transfer/register — Register Transfer / Partial Register: posts
// what is saved, after checking it against what the device saved.
router.post('/register', asyncHandler(controller.register));

module.exports = router;