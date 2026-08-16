const fs = require('fs');
const path = require('path');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Persisted record of every /pick/verify/submit call, including each
 * item's per-unit scanLog.
 *
 * Why this exists separately from demoDataSource: DemoDataSource deletes a
 * pick from _verifyPicks the moment it's submitted (mirrors the prototype's
 * "verified picks disappear from the list" behaviour) — so anything stored
 * only on that in-memory object is gone within the same request. A loose
 * item found mid-batch during verification needs to stay traceable after
 * that point, not just until the list refreshes. Same reasoning as
 * scanExceptionStore.js: this is middleware-generated audit data, not
 * Business Central data, so it lives outside the dataSource adapter swap
 * and persists identically regardless of DATA_SOURCE.
 */
class LocalVerifyAuditStore {
  constructor(storePath) {
    this.storePath = path.resolve(storePath);
    this._records = null;
  }

  _load() {
    if (this._records) return this._records;
    if (!fs.existsSync(this.storePath)) {
      this._records = [];
      return this._records;
    }
    const raw = fs.readFileSync(this.storePath, 'utf-8');
    this._records = raw.trim() ? JSON.parse(raw) : [];
    return this._records;
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(this._records, null, 2));
  }

  append(record) {
    const records = this._load();
    const stored = { ...record, recordedAt: new Date().toISOString() };
    records.push(stored);
    this._persist();
    return stored;
  }

  query({ orderId, limit = 100, offset = 0 } = {}) {
    let records = this._load();
    if (orderId) records = records.filter((r) => r.orderId === orderId);
    records = [...records].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
    return records.slice(offset, offset + limit);
  }
}

const storePath = config.verifyAuditStorePath || './data/verify-audit.json';
logger.info(`Verify audit store: ${path.resolve(storePath)}`);

module.exports = new LocalVerifyAuditStore(storePath);
module.exports.LocalVerifyAuditStore = LocalVerifyAuditStore;
