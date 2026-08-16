const ApiError = require('../utils/apiError');

/**
 * Gates admin-only endpoints (currently: reading the scan-exception audit
 * log). Deliberately does NOT do its own token verification — it relies on
 * `requireAuth` having already run and populated `req.user.role` from the
 * JWT. Mount order matters:
 *
 *   router.get('/exceptions', requireAuth, requireAdmin, handler);
 *
 * There is no separate admin credential store: `role` lives on the same
 * user record in userStore.js as every operator, seeded via
 * `npm run seed:users <username> <password>` with a "role": "admin" entry
 * added to data/users.json afterward (or seed a dedicated script arg if
 * that's added later). This keeps exactly one login flow (`POST
 * /auth/login`) and exactly one place a device/app talks to for
 * authentication, matching how the rest of this codebase avoids parallel
 * paths for the same concern.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    // Defensive — should be unreachable if requireAuth is mounted first.
    return next(ApiError.unauthorized('Your session has expired. Please log in again.'));
  }
  if (req.user.role !== 'admin') {
    return next(ApiError.forbidden('Admin access is required for this action.'));
  }
  next();
}

module.exports = requireAdmin;
