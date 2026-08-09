const express = require('express');
const { login } = require('./authController');

const router = express.Router();

// POST /auth/login — the only unauthenticated route in the whole API.
router.post('/login', login);

module.exports = router;
