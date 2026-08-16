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

    const token = issueToken({ username: user.username, environment: config.env, role: user.role });
    res.json({ token, username: user.username, environment: config.env, role: user.role });
  } catch (err) {
    next(err);
  }
}

module.exports = { login };
