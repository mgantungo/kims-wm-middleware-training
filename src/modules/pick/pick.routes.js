const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./pick.controller');

const router = express.Router();

// GET /pick/documents
router.get('/documents', asyncHandler(controller.listDocuments));
// GET /pick/documents/:docId
router.get('/documents/:docId', asyncHandler(controller.getDocument));
// POST /pick/confirm
router.post('/confirm', asyncHandler(controller.confirmItem));

module.exports = router;
