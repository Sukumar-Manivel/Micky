// Runs once before all tests: test media, a fresh database and Redis, then the whole stack.
import { EXTERNAL_STACK, API } from './support/env.js';
import { generateFixtures } from './support/media.js';
import { flushRedis, migrateAndSeed, recreateDatabase, startStack } from './support/stack.js';

export default async function globalSetup() {
  generateFixtures();
  if (EXTERNAL_STACK) {
    // You started everything yourself (PAYMENTS_PROVIDER=mock, migrated, seeded): just check it answers.
    const res = await fetch(`${API}/health`);
    if (!res.ok) throw new Error(`E2E_EXTERNAL_STACK=1 but ${API}/health answered ${res.status}`);
    return;
  }
  await recreateDatabase();
  await flushRedis();
  migrateAndSeed();
  await startStack();
}
