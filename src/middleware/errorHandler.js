const ApiError = require('../utils/apiError');
const logger = require('../utils/logger');

/**
 * Mounted last, after every route. This is the single place an error
 * becomes an HTTP response — no route handler formats its own error JSON.
 * Anything that isn't already an ApiError (a bug, an unexpected exception
 * from a library) is logged with full detail and converted into a generic
 * 500 with a safe message, so a stack trace never reaches the client and a
 * thrown error never takes the process down.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    if (err.statusCode >= 500) {
      req.log?.error({ err }, err.message);
    } else {
      req.log?.warn({ err: { message: err.message, code: err.code } }, 'Request rejected');
    }
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }

  // Anything else is unexpected — log it in full, tell the client nothing
  // but "something went wrong". This is the Node-side equivalent of the
  // Flutter app's FlutterError.onError / PlatformDispatcher.onError
  // backstop: no unhandled error should ever produce a raw stack trace in
  // the response or silently crash the server.
  (req.log || logger).error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'An internal error occurred. Please try again.', code: 'INTERNAL_ERROR' });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}`, code: 'NOT_FOUND' });
}

module.exports = { errorHandler, notFoundHandler };
