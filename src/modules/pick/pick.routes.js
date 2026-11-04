// src/modules/pick/pick.routes.js
const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./pick.controller');

const router = express.Router();

// GET /pick/documents
router.get('/documents', asyncHandler(controller.listDocuments));
// GET /pick/documents/:docId
router.get('/documents/:docId', asyncHandler(controller.getDocument));
// POST /pick/confirm — single real-time scan (BC Section 2.9).
router.post('/confirm', asyncHandler(controller.confirmItem));
// POST /pick/confirm-batch — one save of picked units (BC Section 2.10).
router.post('/confirm-batch', asyncHandler(controller.confirmBatch));
// POST /pick/check-bin — can this item be taken from the scanned bin?
// (bin contents, BC Section 2.2.2)
router.post('/check-bin', asyncHandler(controller.checkBin));
// GET /pick/documents/:docId/verification — dispatch verification per
// item / lot / serial group (BC Section 2.11). Live.
router.get('/documents/:docId/verification', asyncHandler(controller.getVerification));
// GET /pick/verification — picks with picked items waiting to be verified
// (the app's Verify Pick list). Live.
router.get('/verification', asyncHandler(controller.listToVerify));
// POST /pick/verification — Verify (partial: false) / Partial Verify
// (partial: true): the verifier's counts (BC Section 2.11.5). Live.
// Not under /pick/verify — that path belongs to Verify & Pack (app.js).
router.post('/verification', asyncHandler(controller.verify));
// POST /pick/register — manual Register (BC Section 2.12), only once the
// pick is verified.
router.post('/register', asyncHandler(controller.register));

module.exports = router;