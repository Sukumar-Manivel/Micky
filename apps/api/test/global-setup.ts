// Runs once before the e2e suite: applies migrations to the test database.
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export default async function setup() {
  // globalSetup runs outside the test environment, so it computes the same URL itself.
  const url =
    process.env.TEST_DATABASE_URL ?? 'postgresql://micky:micky@localhost:5432/micky_test';
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}
