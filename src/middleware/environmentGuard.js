const config = require('../config/env');
const ApiError = require('../utils/apiError');

/**
 * The Flutter app's ApiClient sends an `X-KIMS-Environment: live|training`
 * header on every request, matching the segmented control the operator
 * chose at login. This deployment is *also* pinned to one environment via
 * KIMS_ENV. If the two ever disagree — e.g. a training build accidentally
 * pointed at the prod URL, or a stale app build talking to a redeployed
 * environment — that's exactly the class of mistake worth failing loudly
 * and immediately on, rather than silently writing training-mode scans
 * into production data or vice versa.
 */
function environmentGuard(req, res, next) {
  const headerEnv = req.header('X-KIMS-Environment');
  if (!headerEnv) return next();

  const normalized = headerEnv === 'live' ? 'production' : headerEnv;
  if (normalized !== config.env) {
    return next(
      ApiError.badRequest(
        `This server is configured for "${config.env}" but the app declared "${headerEnv}". Check the app's environment switch and the middleware URL it's pointed at.`,
        'ENVIRONMENT_MISMATCH',
      ),
    );
  }
  next();
}

module.exports = environmentGuard;
