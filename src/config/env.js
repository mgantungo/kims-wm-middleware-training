// src/config/env.js
require('dotenv').config();

/**
 * Single place every other module reads configuration from. Nothing else
 * in the codebase calls `process.env` directly — that keeps validation in
 * one spot and means a missing/misconfigured variable fails loudly at boot
 * instead of surfacing as a confusing runtime bug three requests later.
 */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

const KIMS_ENV = required('KIMS_ENV');
if (!['training', 'production'].includes(KIMS_ENV)) {
  throw new Error(`KIMS_ENV must be "training" or "production", got "${KIMS_ENV}"`);
}

const DATA_SOURCE = process.env.DATA_SOURCE || 'demo';
if (!['demo', 'businessCentral', 'hybrid'].includes(DATA_SOURCE)) {
  throw new Error(`DATA_SOURCE must be "demo", "businessCentral", or "hybrid", got "${DATA_SOURCE}"`);
}

if (DATA_SOURCE === 'demo' && KIMS_ENV === 'production') {
  // Not a hard failure — during early rollout you may deliberately want
  // demo data on the prod URL for a client walkthrough — but this is
  // exactly the kind of mistake that's cheap to catch at boot and
  // expensive to catch after a warehouse crew starts scanning against it.
  // eslint-disable-next-line no-console
  console.warn('[config] WARNING: KIMS_ENV=production but DATA_SOURCE=demo. Confirm this is intentional.');
}

// Only meaningful when DATA_SOURCE=hybrid — which of Put Away's methods
// hit Business Central vs. stay on demo data. Read and confirm are
// independent on purpose: reading is low-risk, confirming writes to a
// live inventory system, so verifying reads before ever trusting writes
// is the point. Every OTHER method in hybrid mode is always demo
// regardless of these values — see hybridDataSource.js. These are the
// flags a genuinely phased rollout flips per phase; DATA_SOURCE itself
// should just stay "hybrid" throughout.
const PUT_AWAY_READ_SOURCE = process.env.PUT_AWAY_READ_SOURCE || 'demo';
if (!['demo', 'businessCentral'].includes(PUT_AWAY_READ_SOURCE)) {
  throw new Error(`PUT_AWAY_READ_SOURCE must be "demo" or "businessCentral", got "${PUT_AWAY_READ_SOURCE}"`);
}

const PUT_AWAY_CONFIRM_SOURCE = process.env.PUT_AWAY_CONFIRM_SOURCE || 'demo';
if (!['demo', 'businessCentral'].includes(PUT_AWAY_CONFIRM_SOURCE)) {
  throw new Error(`PUT_AWAY_CONFIRM_SOURCE must be "demo" or "businessCentral", got "${PUT_AWAY_CONFIRM_SOURCE}"`);
}

// Routing for validatePutAwayBin/suggestPutAwayBin (Stop & Split's
// capacity check) — kept as its own flag, independently switchable from
// read/confirm above. Setting this to businessCentral today has NO
// effect: businessCentralDataSource.js's implementations of both are
// still _notImplemented(), since the documented /Bins endpoint has no
// capacity field to check against. This flag exists now specifically so
// that once someone implements them for real (Business Central exposes
// a capacity-aware endpoint), flipping this single value is the ONLY
// remaining step — no further code change needed in hybridDataSource.js
// or anywhere else.
const PUT_AWAY_SPLIT_SOURCE = process.env.PUT_AWAY_SPLIT_SOURCE || 'demo';
if (!['demo', 'businessCentral'].includes(PUT_AWAY_SPLIT_SOURCE)) {
  throw new Error(`PUT_AWAY_SPLIT_SOURCE must be "demo" or "businessCentral", got "${PUT_AWAY_SPLIT_SOURCE}"`);
}

// Bin Inquiry is its own module, independent of Put Away entirely — not
// tied to PUT_AWAY_READ_SOURCE/PUT_AWAY_CONFIRM_SOURCE above. Read-only,
// so there's no separate "confirm" side to this one. See
// businessCentralDataSource.js's searchBin for why the response is only
// ever a PARTIAL mapping (bin metadata, never contents) even once this
// is set to businessCentral.
const BIN_INQUIRY_SOURCE = process.env.BIN_INQUIRY_SOURCE || 'demo';
if (!['demo', 'businessCentral'].includes(BIN_INQUIRY_SOURCE)) {
  throw new Error(`BIN_INQUIRY_SOURCE must be "demo" or "businessCentral", got "${BIN_INQUIRY_SOURCE}"`);
}

// Business Central uses HTTP Basic Auth (username + Web Service Access
// Key), not OAuth2 — see the KIMS-WM API Endpoint Reference doc, Section
// 1. Only required when Business Central is ACTUALLY reachable through
// the current config — either DATA_SOURCE=businessCentral outright, or
// DATA_SOURCE=hybrid with any of the per-module source flags set to
// businessCentral. A demo-only deployment never touches these and
// shouldn't have to set them.
const businessCentral = {
  baseUrl: process.env.BC_BASE_URL || null,
  companyId: process.env.BC_COMPANY_ID || null,
  username: process.env.BC_USERNAME || null,
  password: process.env.BC_PASSWORD || null,
};

const businessCentralInUse =
  DATA_SOURCE === 'businessCentral' ||
  (DATA_SOURCE === 'hybrid' &&
    (PUT_AWAY_READ_SOURCE === 'businessCentral' ||
      PUT_AWAY_CONFIRM_SOURCE === 'businessCentral' ||
      PUT_AWAY_SPLIT_SOURCE === 'businessCentral' ||
      BIN_INQUIRY_SOURCE === 'businessCentral'));

if (businessCentralInUse) {
  const missing = Object.entries(businessCentral)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    const hybridDetail =
      DATA_SOURCE === 'hybrid'
        ? `, PUT_AWAY_READ_SOURCE=${PUT_AWAY_READ_SOURCE}, PUT_AWAY_CONFIRM_SOURCE=${PUT_AWAY_CONFIRM_SOURCE}, ` +
          `PUT_AWAY_SPLIT_SOURCE=${PUT_AWAY_SPLIT_SOURCE}, BIN_INQUIRY_SOURCE=${BIN_INQUIRY_SOURCE}`
        : '';
    throw new Error(
      `Business Central is in use (DATA_SOURCE=${DATA_SOURCE}${hybridDetail}) ` +
        `but BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME, and BC_PASSWORD aren't all set — missing: ${missing.join(', ')}.`,
    );
  }
}

module.exports = {
  env: KIMS_ENV,
  port: parseInt(process.env.PORT || '3000', 10),
  dataSource: DATA_SOURCE,
  putAwayReadSource: PUT_AWAY_READ_SOURCE,
  putAwayConfirmSource: PUT_AWAY_CONFIRM_SOURCE,
  putAwaySplitSource: PUT_AWAY_SPLIT_SOURCE,
  binInquirySource: BIN_INQUIRY_SOURCE,
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  userStorePath: process.env.USER_STORE_PATH || './data/users.json',
  scanExceptionStorePath: process.env.SCAN_EXCEPTION_STORE_PATH || './data/scan-exceptions.json',
  verifyAuditStorePath: process.env.VERIFY_AUDIT_STORE_PATH || './data/verify-audit.json',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  businessCentral,
};