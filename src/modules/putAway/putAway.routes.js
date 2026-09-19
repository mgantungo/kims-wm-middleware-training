// src/modules/putAway/putAway.routes.js
const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./putAway.controller');

const router = express.Router();

// GET /put-away/documents
router.get('/documents', asyncHandler(controller.listDocuments));
// GET /put-away/documents/:docId
router.get('/documents/:docId', asyncHandler(controller.getDocument));
// POST /put-away/confirm
router.post('/confirm', asyncHandler(controller.confirmItem));
// POST /put-away/confirm-batch — Section 2.7's batch scan, replacing N
// per-line confirm calls with one call per bin/document.
router.post('/confirm-batch', asyncHandler(controller.confirmBatch));
// POST /put-away/validate-bin
router.post('/validate-bin', asyncHandler(controller.validateBin));
// POST /put-away/suggest-bin
router.post('/suggest-bin', asyncHandler(controller.suggestBin));
// POST /put-away/check-bin — for a line Business Central left unassigned:
// is the bin the operator just scanned available to become its location?
router.post('/check-bin', asyncHandler(controller.checkBin));
// POST /put-away/register — whole-document Register event, once every
// line has been confirmed (KIMS-WM API doc Section 2.6).
router.post('/register', asyncHandler(controller.register));

module.exports = router;