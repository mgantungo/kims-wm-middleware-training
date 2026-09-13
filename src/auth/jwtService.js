const jwt = require('jsonwebtoken');
const config = require('../config/env');

/**
 * Only place tokens are signed. Keeps the JWT secret and expiry policy in
 * one spot so it can't drift between login and any future token-refresh
 * endpoint.
 */
function issueToken({ username, environment, role, locationCode }) {
  // 'loc' (not the full field name) to match the existing short-claim
  // convention (sub/env/role) already established here — kept minimal
  // since JWT payloads are base64, not encrypted; every byte in here is
  // visible to anyone who inspects the token.
  return jwt.sign({ sub: username, env: environment, role, loc: locationCode }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

module.exports = { issueToken };