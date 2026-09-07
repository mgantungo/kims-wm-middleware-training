// src/modules/quarantine/quarantine.routes.js
const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./quarantine.controller');

const router = express.Router();

// GET /quarantine/documents
router.get('/documents', asyncHandler(controller.listDocuments));
// GET /quarantine/documents/:docId
router.get('/documents/:docId', asyncHandler(controller.getDocument));
// POST /quarantine/validate-bin — split-only, same scope as Transfer's:
// the operator arrived at the assigned quarantine bin and found it
// short. Never used to decide the original quarantine zone.
router.post('/validate-bin', asyncHandler(controller.validateBin));
// POST /quarantine/suggest-bin — split-only auto-assign, restricted to
// bins flagged as quarantine zones.
router.post('/suggest-bin', asyncHandler(controller.suggestBin));
// POST /quarantine/confirm
router.post('/confirm', asyncHandler(controller.confirmItem));

module.exports = router;