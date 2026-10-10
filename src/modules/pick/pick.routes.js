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
// POST /pick/confirm-batch — whole pick in one call, then Register
// (BC Sections 2.10 + 2.11).
router.post('/confirm-batch', asyncHandler(controller.confirmBatch));
// POST /pick/register — manual Register (BC Section 2.11).
router.post('/register', asyncHandler(controller.register));

module.exports = router;
