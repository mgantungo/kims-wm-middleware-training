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
if (!['demo', 'businessCentral'].includes(DATA_SOURCE)) {
  throw new Error(`DATA_SOURCE must be "demo" or "businessCentral", got "${DATA_SOURCE}"`);
}

if (DATA_SOURCE === 'demo' && KIMS_ENV === 'production') {
  // Not a hard failure — during early rollout you may deliberately want
  // demo data on the prod URL for a client walkthrough — but this is
  // exactly the kind of mistake that's cheap to catch at boot and
  // expensive to catch after a warehouse crew starts scanning against it.
  // eslint-disable-next-line no-console
  console.warn('[config] WARNING: KIMS_ENV=production but DATA_SOURCE=demo. Confirm this is intentional.');
}

module.exports = {
  env: KIMS_ENV,
  port: parseInt(process.env.PORT || '3000', 10),
  dataSource: DATA_SOURCE,
  jwt: {
    secret: required('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  userStorePath: process.env.USER_STORE_PATH || './data/users.json',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  businessCentral: {
    tenantId: process.env.BC_TENANT_ID || null,
    environmentName: process.env.BC_ENVIRONMENT_NAME || null,
    clientId: process.env.BC_CLIENT_ID || null,
    clientSecret: process.env.BC_CLIENT_SECRET || null,
    companyId: process.env.BC_COMPANY_ID || null,
  },
};
