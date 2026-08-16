const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * Only place tokens are signed. Keeps the JWT secret and expiry policy in
 * one spot so it can't drift between login and any future token-refresh
 * endpoint.
 */
function issueToken({ username, environment, role }) {
  return jwt.sign({ sub: username, env: environment, role }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

module.exports = { issueToken };
