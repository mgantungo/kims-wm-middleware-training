/**
 * Express doesn't automatically forward a rejected Promise from an async
 * route handler into the error-handling middleware — an unwrapped async
 * handler that throws just hangs the request or crashes the process. Every
 * route in this codebase is wrapped in this so that guarantee is structural
 * rather than something each handler has to remember to do with try/catch.
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
