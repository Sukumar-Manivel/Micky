// Creates the first admin account. Run with: npm run db:seed
// Admins cannot sign up through the API, so this is the only way to create one.
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { BCRYPT_MAX_BYTES, isAccountEmail, normaliseEmail } from '../auth/auth.dto.js';
import * as schema from './schema.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME = 'FirstFrame Admin' } = process.env;
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Set DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD');
  process.exit(1);
}
// Same rule as the login form (auth.dto.ts), so the seeded admin can always log in.
// e.g. "admin@firstframe.e2e" is refused: a TLD with a digit is not a valid email to the API.
const email = normaliseEmail(ADMIN_EMAIL);
if (!isAccountEmail(email)) {
  console.error(`ADMIN_EMAIL "${email}" is not an address the login form accepts (try a normal domain like admin@example.com)`);
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters');
  process.exit(1);
}
if (Buffer.byteLength(ADMIN_PASSWORD, 'utf8') > BCRYPT_MAX_BYTES) {
  console.error(`ADMIN_PASSWORD must be at most ${BCRYPT_MAX_BYTES} bytes (bcrypt ignores the rest)`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
const db = drizzle(pool, { schema });
try {
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing) {
    console.log(`Admin ${email} already exists`);
  } else {
    await db.insert(schema.users).values({
      email,
      name: ADMIN_NAME,
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    });
    console.log(`Created admin ${email}`);
  }
} finally {
  await pool.end();
}
