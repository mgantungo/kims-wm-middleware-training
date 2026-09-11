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

// Only meaningful when DATA_SOURCE=hybrid — which of Put Away's two read
// methods (getPutAwayDocuments/getPutAwayDocument) hit Business Central
// vs. stay on demo data. Every OTHER method in hybrid mode is always
// demo regardless of this value — see hybridDataSource.js. This is the
// one flag a genuinely phased rollout flips per phase; DATA_SOURCE itself
// should just stay "hybrid" throughout.
const PUT_AWAY_READ_SOURCE = process.env.PUT_AWAY_READ_SOURCE || 'demo';
if (!['demo', 'businessCentral'].includes(PUT_AWAY_READ_SOURCE)) {
  throw new Error(`PUT_AWAY_READ_SOURCE must be "demo" or "businessCentral", got "${PUT_AWAY_READ_SOURCE}"`);
}

// Business Central uses HTTP Basic Auth (username + Web Service Access
// Key), not OAuth2 — see the KIMS-WM API Endpoint Reference doc, Section
// 1. Only required when Business Central is ACTUALLY reachable through
// the current config — either DATA_SOURCE=businessCentral outright, or
// DATA_SOURCE=hybrid with PUT_AWAY_READ_SOURCE=businessCentral. A
// demo-only deployment never touches these and shouldn't have to set
// them.
const businessCentral = {
  baseUrl: process.env.BC_BASE_URL || null,
  companyId: process.env.BC_COMPANY_ID || null,
  username: process.env.BC_USERNAME || null,
  password: process.env.BC_PASSWORD || null,
};

const businessCentralInUse =
  DATA_SOURCE === 'businessCentral' || (DATA_SOURCE === 'hybrid' && PUT_AWAY_READ_SOURCE === 'businessCentral');

if (businessCentralInUse) {
  const missing = Object.entries(businessCentral)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Business Central is in use (DATA_SOURCE=${DATA_SOURCE}${DATA_SOURCE === 'hybrid' ? `, PUT_AWAY_READ_SOURCE=${PUT_AWAY_READ_SOURCE}` : ''}) ` +
        `but BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME, and BC_PASSWORD aren't all set — missing: ${missing.join(', ')}.`,
    );
  }
}

module.exports = {
  env: KIMS_ENV,
  port: parseInt(process.env.PORT || '3000', 10),
  dataSource: DATA_SOURCE,
  putAwayReadSource: PUT_AWAY_READ_SOURCE,
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