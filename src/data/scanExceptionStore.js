const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../utils/logger');

/**
 * Local, file-backed audit log of rejected/mismatched scans (wrong item,
 * wrong bin, item not on the active document) pushed from Put Away, Pick,
 * and Verify on the device.
 *
 * This deliberately lives OUTSIDE the dataSource adapter pattern
 * (dataSourceFactory / demoDataSource / businessCentralDataSource): a scan
 * exception isn't Business Central data being read or written through — it's
 * a record this middleware itself generates from device activity, and it
 * needs to persist and be queryable by admins regardless of which data
 * source is active or what Phase 2 looks like. Swapping DATA_SOURCE in .env
 * has no bearing on this store.
 *
 * Same persistence approach as userStore.js: flat JSON file, loaded lazily,
 * rewritten on every append. Fine for warehouse-floor exception volume;
 * revisit if this ever needs concurrent multi-process writers.
 */
class LocalScanExceptionStore {
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

  /**
   * Upserts by `localId` (the client-generated uuid from the device's
   * scan_log_entries row) rather than always inserting. The device's
   * SyncManager may retry this push after a dropped response even though
   * the first attempt actually landed — upserting keeps a retried push from
   * creating a duplicate audit entry.
   */
  append(record) {
    const records = this._load();
    const existingIdx = records.findIndex((r) => r.localId === record.localId);
    const stored = { ...record, receivedAt: new Date().toISOString() };
    if (existingIdx >= 0) {
      records[existingIdx] = stored;
    } else {
      records.push(stored);
    }
    this._persist();
    return stored;
  }

  query({ docId, status, limit = 100, offset = 0 } = {}) {
    let records = this._load();
    if (docId) records = records.filter((r) => r.docId === docId);
    if (status) records = records.filter((r) => r.status === status);
    records = [...records].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
    return records.slice(offset, offset + limit);
  }
}

const storePath = config.scanExceptionStorePath || './data/scan-exceptions.json';
logger.info(`Scan exception audit store: ${path.resolve(storePath)}`);

module.exports = new LocalScanExceptionStore(storePath);
module.exports.LocalScanExceptionStore = LocalScanExceptionStore;
module.exports.generateLocalId = () => crypto.randomUUID();
