const userStore = require('./userStore');
const { issueToken } = require('./jwtService');
const ApiError = require('../utils/apiError');
const config = require('../config/env');

/**
 * Matches AuthApi.login on the Flutter side exactly: expects
 * { username, password } and returns { token }. AuthRepository on the app
 * treats a missing/failed token as an AuthException, so error responses
 * here always use ApiError.unauthorized for bad credentials.
 */
async function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw ApiError.badRequest('Username and password are required.');
    }

    const user = userStore.findByUsername(username);
    if (!user) {
      throw ApiError.unauthorized('Invalid username or password.');
    }

    const valid = await userStore.verifyPassword(user, password);
    if (!valid) {
      throw ApiError.unauthorized('Invalid username or password.');
    }

    const token = issueToken({
      username: user.username,
      environment: config.env,
      role: user.role,
      // Which Business Central warehouse LOCATION this operator is
      // restricted to (e.g. "3PL-WH-BKL") — see WHEmps in the KIMS-WM
      // API doc for where this concept comes from on the Business
      // Central side. Add it to each entry in the local user store
      // (users.json) directly; there's no per-request lookup here, since
      // Business Central login was explicitly ruled out — the operator
      // directory stays local, only this one extra field is new.
      locationCode: user.locationCode,
    });
    res.json({
      token,
      username: user.username,
      environment: config.env,
      role: user.role,
      locationCode: user.locationCode,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { login };