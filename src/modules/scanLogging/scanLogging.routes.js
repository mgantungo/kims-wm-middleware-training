const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const requireAdmin = require('../../middleware/requireAdmin');
const controller = require('./scanLogging.controller');

const router = express.Router();

// POST /scan-logging/exceptions — device push, same auth as every other
// route in this group (requireAuth is applied where this router is
// mounted in app.js, not here).
router.post('/exceptions', asyncHandler(controller.logException));

// GET /scan-logging/exceptions — admin-only audit view. requireAdmin runs
// after the group-level requireAuth already populated req.user.
router.get('/exceptions', requireAdmin, asyncHandler(controller.listExceptions));

// GET /scan-logging/verify-submissions — admin-only. Full verify
// submissions including each item's scanLog, for tracing loose/misplaced
// items found during verification.
router.get('/verify-submissions', requireAdmin, asyncHandler(controller.listVerifySubmissions));

module.exports = router;
