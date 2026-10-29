// src/data/adapters/bcEndpoints.js
const logger = require('../../utils/logger');

/**
 * Business Central is reached on one address for every endpoint:
 *
 *   BC_BASE_URL=http://erp.klanlogistics.com:7048/KLL/api/kll/wh/v2.0
 *
 * (BC_BASE_URL could list several addresses, comma separated; with one
 * address everything below simply always uses it.)
 *
 * Every Business Central call goes through [BcEndpoints.fetch], which uses
 * the address that last worked and moves to the next one when it can't be
 * reached. A single address works exactly as before.
 *
 * WHEN IT MOVES TO THE NEXT ADDRESS
 *   Reads (GET) ...... on any network failure, and on 502 / 503 / 504
 *                      (a proxy in front of Business Central that is up
 *                      while Business Central behind it is not). Reading
 *                      twice is harmless.
 *   Writes (POST /
 *   PATCH) ........... ONLY when the request provably never reached the
 *                      server — connection refused, host not found or
 *                      unreachable, connect timeout. A write that may have
 *                      arrived (connection dropped mid-request, response
 *                      lost) is NEVER sent to another address: Business
 *                      Central adds every scan to the line and does not
 *                      de-duplicate, so resending could count it twice.
 *                      That failure goes back to the app as before, and the
 *                      app's outbox retries it with its own resend
 *                      protection.
 *
 * GOING BACK TO THE FIRST ADDRESS. After a switch, the first (preferred)
 * address is tried again first every BC_FAILBACK_MINUTES (default 5), so
 * the middleware returns to it once it is back.
 *
 * CHECKING THEM. [BcEndpoints.probeAll] tries every address with one small
 * read and logs which answer — run at startup (src/server.js) and on demand
 * with `npm run check:bc` (scripts/checkBcUrls.js). The first address that
 * answers becomes the one in use.
 */

/// Network error codes that mean the request never got to the server, so
/// even a write can safely go to the next address. (Node's fetch puts the
/// code on error.cause.)
const NEVER_ARRIVED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const GATEWAY_STATUSES = new Set([502, 503, 504]);

function errorCode(error) {
  return (error && error.cause && (error.cause.code || error.cause.name)) || (error && (error.code || error.name)) || 'UNKNOWN';
}

/// "http://a/b/" -> "http://a/b"; blanks dropped; duplicates dropped.
function parseBaseUrls(raw) {
  const seen = new Set();
  return String(raw || '')
    .split(/[,\s]+/)
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter((u) => u && !seen.has(u) && seen.add(u));
}

class BcEndpoints {
  constructor(urls, { failbackMinutes = 5 } = {}) {
    this.urls = urls;
    this.failbackMs = Math.max(0, Number(failbackMinutes) || 0) * 60 * 1000;
    this.active = 0;
    this.lastFailbackTry = 0;
  }

  get activeUrl() {
    return this.urls[this.active];
  }

  /// Order to try: the address in use first; but once BC_FAILBACK_MINUTES
  /// has passed since we left the preferred one, try it first again.
  _order() {
    const rest = this.urls.map((_, i) => i).filter((i) => i !== this.active);
    if (this.active !== 0 && this.failbackMs > 0 && Date.now() - this.lastFailbackTry >= this.failbackMs) {
      this.lastFailbackTry = Date.now();
      return [0, this.active, ...rest.filter((i) => i !== 0)];
    }
    return [this.active, ...rest];
  }

  _use(index) {
    if (index === this.active) return;
    const from = this.urls[this.active];
    this.active = index;
    this.lastFailbackTry = Date.now();
    logger.warn({ from, to: this.urls[index] }, `Business Central: now using ${this.urls[index]}`);
  }

  /// fetch(`${baseUrl}${path}`, init) against the addresses in turn — see
  /// the class doc for when it moves on. [path] starts with '/'. Returns
  /// the Response of the address that answered; throws the last network
  /// error when none did (its message lists every address tried).
  async fetch(path, init = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const order = this._order();
    const failures = [];

    for (let n = 0; n < order.length; n++) {
      const index = order[n];
      const base = this.urls[index];
      const last = n === order.length - 1;
      let response;
      try {
        response = await fetch(`${base}${path}`, init);
      } catch (error) {
        const code = errorCode(error);
        failures.push(`${base} (${code})`);
        if (!isRead && !NEVER_ARRIVED.has(code)) {
          // A write that may have reached Business Central — never resent
          // to another address (see class doc).
          error.message = `${error.message} [${base}; not retried on another address — the request may have arrived]`;
          throw error;
        }
        if (!last) logger.warn({ base, code, method }, `Business Central: ${base} unreachable (${code}) — trying the next address`);
        continue;
      }
      if (isRead && GATEWAY_STATUSES.has(response.status) && !last) {
        failures.push(`${base} (HTTP ${response.status})`);
        logger.warn({ base, status: response.status }, `Business Central: ${base} answered ${response.status} — trying the next address`);
        continue;
      }
      this._use(index);
      return response;
    }

    const err = new Error(`no Business Central address answered — tried ${failures.join(', ')}`);
    err.code = 'BC_ALL_UNREACHABLE';
    throw err;
  }

  /// Tries every address with one small read (GET companies(<id>)/
  /// locations?$top=1) and reports each: { url, ok, status, ms, error }.
  /// The first that answers OK becomes the one in use. Never throws.
  async probeAll({ companyId, authHeader, timeoutMs = 10000 } = {}) {
    const results = [];
    for (const url of this.urls) {
      const started = Date.now();
      try {
        const response = await fetch(`${url}/companies(${companyId})/locations?$top=1`, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        results.push({ url, ok: response.ok, status: response.status, ms: Date.now() - started, error: null });
      } catch (error) {
        results.push({ url, ok: false, status: null, ms: Date.now() - started, error: errorCode(error) });
      }
    }
    const firstOk = results.findIndex((r) => r.ok);
    if (firstOk >= 0) this._use(firstOk);
    return results;
  }
}

/// One shared set of addresses per configuration, so the adapter (and the
/// hybrid adapter's own copy of it), the startup check and the health
/// check all see the same "address in use".
const shared = new Map();

function getBcEndpoints(config) {
  const urls = config && Array.isArray(config.baseUrls) && config.baseUrls.length > 0
    ? config.baseUrls
    : parseBaseUrls(config && config.baseUrl);
  const key = urls.join(',');
  if (!shared.has(key)) shared.set(key, new BcEndpoints(urls, { failbackMinutes: config && config.failbackMinutes }));
  return shared.get(key);
}

/// Startup / on-demand check: logs one line per address and a summary.
/// Returns the results. Never throws.
async function checkBcEndpoints(config, log = logger) {
  if (!config || !config.companyId || !config.username || !config.password) return [];
  const endpoints = getBcEndpoints(config);
  const authHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  const results = await endpoints.probeAll({ companyId: config.companyId, authHeader });
  for (const r of results) {
    if (r.ok) log.info(`Business Central address OK: ${r.url} (HTTP ${r.status}, ${r.ms} ms)`);
    else if (r.status != null) log.warn(`Business Central address reachable but refused the check: ${r.url} (HTTP ${r.status}, ${r.ms} ms)`);
    else log.warn(`Business Central address NOT available: ${r.url} (${r.error}, ${r.ms} ms)`);
  }
  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) log.error('Business Central: none of the configured addresses answered.');
  else log.info(`Business Central: ${okCount} of ${results.length} address(es) available — using ${endpoints.activeUrl}`);
  return results;
}

module.exports = { BcEndpoints, getBcEndpoints, checkBcEndpoints, parseBaseUrls };