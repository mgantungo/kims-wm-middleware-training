/**
 * The only error type route handlers/services should throw. Mirrors the
 * Flutter app's AppException hierarchy on purpose: the app's ApiClient
 * already knows how to turn a JSON body of shape
 *   { "error": "message", "code": "SOME_CODE" }
 * plus an HTTP status into the right AppException subtype (401/403 ->
 * AuthException, 5xx -> ApiServerException, other 4xx -> ApiRequestException).
 * Keeping the contract deliberate here means the client-side error mapping
 * never has to guess.
 */
class ApiError extends Error {
  constructor(statusCode, message, code = 'ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(message, code = 'BAD_REQUEST') {
    return new ApiError(400, message, code);
  }

  static unauthorized(message = 'Invalid credentials.', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }

  static forbidden(message = 'Not authorized to perform this action.', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Resource not found.', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, message, code);
  }

  static internal(message = 'An internal error occurred.', code = 'INTERNAL_ERROR') {
    return new ApiError(500, message, code);
  }
}

module.exports = ApiError;
