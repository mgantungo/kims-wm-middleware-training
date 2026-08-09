const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Local, file-backed operator directory. This is deliberately isolated
 * behind a small interface (findByUsername / verifyPassword) so swapping
 * to Business Central or Azure AD later — the intended Phase 2 path — only
 * means writing a new class with the same two methods and pointing
 * auth.controller.js at it, exactly like the Flutter app's DataSource
 * adapter pattern on the BC data side.
 *
 * Passwords are bcrypt-hashed at rest. Never store plaintext, even for a
 * "temporary" local store — temporary auth stores have a way of outliving
 * their intended lifespan.
 */
class LocalUserStore {
  constructor(storePath) {
    this.storePath = path.resolve(storePath);
    this._users = null;
  }

  _load() {
    if (this._users) return this._users;
    if (!fs.existsSync(this.storePath)) {
      logger.warn(`No user store found at ${this.storePath} — run "npm run seed:users" to create one.`);
      this._users = [];
      return this._users;
    }
    const raw = fs.readFileSync(this.storePath, 'utf-8');
    this._users = JSON.parse(raw);
    return this._users;
  }

  findByUsername(username) {
    const users = this._load();
    return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
  }

  async verifyPassword(user, plaintextPassword) {
    return bcrypt.compare(plaintextPassword, user.passwordHash);
  }

  /** Used only by the seed script — never exposed over HTTP. */
  static async hashPassword(plaintext) {
    return bcrypt.hash(plaintext, 10);
  }
}

module.exports = new LocalUserStore(config.userStorePath);
module.exports.LocalUserStore = LocalUserStore;
