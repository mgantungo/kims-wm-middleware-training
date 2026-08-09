const jwt = require('jsonwebtoken');
const config = require('../config/env');
const ApiError = require('../utils/apiError');

/**
 * Verifies the Bearer token the Flutter app's ApiClient attaches to every
 * request once logged in (see AuthRepository / ApiClient.updateAuthToken
 * on the client side). On success, attaches `req.user` for downstream
 * handlers; on failure, throws the same AuthException-shaped 401 the app
 * already knows how to react to (AuthRepository treats a 401/403 as
 * "session expired, please log in again").
 */
function requireAuth(req, res, next) {
  const header = req.header('Authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Your session has expired. Please log in again.'));
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = { username: payload.sub, environment: payload.env };
    next();
  } catch (err) {
    next(ApiError.unauthorized('Your session has expired. Please log in again.'));
  }
}

module.exports = requireAuth;
