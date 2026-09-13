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
    req.user = {
      username: payload.sub,
      environment: payload.env,
      role: payload.role,
      // Which BC location this operator is restricted to — see
      // jwtService.js's issueToken. Every route handler that needs to
      // enforce "only bins/zones/documents belonging to MY location" (Bin
      // Inquiry, Put Away, and eventually Transfer/Quarantine) should
      // read this off req.user, NOT trust a client-supplied locationCode
      // query/body param for that purpose — a param the app sends can be
      // omitted or altered; a claim verified here cannot. Enforcement
      // itself isn't wired into any route yet — this is the plumbing
      // that makes doing so possible next, not the enforcement.
      locationCode: payload.loc,
    };
    next();
  } catch (err) {
    next(ApiError.unauthorized('Your session has expired. Please log in again.'));
  }
}

module.exports = requireAuth;