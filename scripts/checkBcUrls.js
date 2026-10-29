// scripts/checkBcUrls.js
/**
 * Checks every Business Central address in BC_BASE_URL (comma separated)
 * with one small read, and says which answer. Run with: npm run check:bc
 *
 * Exit code 0 when at least one address answers, 1 when none does — so it
 * can also be used from a cron job or monitoring.
 */
require('dotenv').config();
const { checkBcEndpoints, parseBaseUrls } = require('../src/data/adapters/bcEndpoints');

const log = {
  info: (m) => console.log(`OK    ${m}`),
  warn: (m) => console.log(`FAIL  ${m}`),
  error: (m) => console.log(`FAIL  ${m}`),
};

async function main() {
  const config = {
    baseUrls: parseBaseUrls(process.env.BC_BASE_URL),
    companyId: process.env.BC_COMPANY_ID,
    username: process.env.BC_USERNAME,
    password: process.env.BC_PASSWORD,
  };
  if (config.baseUrls.length === 0 || !config.companyId || !config.username || !config.password) {
    console.log('BC_BASE_URL, BC_COMPANY_ID, BC_USERNAME and BC_PASSWORD must all be set in .env.');
    process.exit(1);
  }
  console.log(`Checking ${config.baseUrls.length} Business Central address(es)…`);
  const results = await checkBcEndpoints(config, log);
  process.exit(results.some((r) => r.ok) ? 0 : 1);
}

main();