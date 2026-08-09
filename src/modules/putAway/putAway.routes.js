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

module.exports = router;
