/**
 * Seeds (or re-seeds) the local JSON user store with bcrypt-hashed
 * passwords. Run with: npm run seed:users
 *
 * Usage:
 *   node scripts/seedUsers.js                                  -> seeds default demo user
 *   node scripts/seedUsers.js <username> <password>             -> adds/updates a warehouse_operator
 *   node scripts/seedUsers.js <username> <password> admin       -> adds/updates an admin user
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { LocalUserStore } = require('../src/auth/userStore');

const storePath = path.resolve(process.env.USER_STORE_PATH || './data/users.json');

async function main() {
  const [, , argUsername, argPassword, argRole] = process.argv;

  const existing = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf-8')) : [];

  if (argUsername && argPassword) {
    const role = argRole === 'admin' ? 'admin' : 'warehouse_operator';
    const passwordHash = await LocalUserStore.hashPassword(argPassword);
    const idx = existing.findIndex((u) => u.username.toLowerCase() === argUsername.toLowerCase());
    const record = { username: argUsername, passwordHash, role };
    if (idx >= 0) existing[idx] = record;
    else existing.push(record);
    console.log(`Upserted ${role} user "${argUsername}".`);
  } else if (existing.length === 0) {
    // First run, no args — seed the demo operator matching the app's
    // default login field ("wh-jdoe") so a fresh checkout works end to end
    // immediately.
    const passwordHash = await LocalUserStore.hashPassword('changeme123');
    existing.push({ username: 'wh-jdoe', passwordHash, role: 'warehouse_operator' });
    console.log('Seeded default demo user: wh-jdoe / changeme123 — CHANGE THIS before going live.');
  } else {
    console.log('User store already has users and no username/password was given — nothing to do.');
    return;
  }

  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(existing, null, 2));
  console.log(`Wrote ${existing.length} user(s) to ${storePath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
