// Stops every process global setup started. The database is kept for debugging a failed run
// (it is recreated at the next start); set E2E_DROP_DB=1 to drop it as well.
import { EXTERNAL_STACK } from './support/env.js';
import { dropDatabase, flushRedis, stopStack } from './support/stack.js';

export default async function globalTeardown() {
  if (EXTERNAL_STACK) return;
  stopStack();
  if (process.env.E2E_DROP_DB === '1') {
    await dropDatabase();
    await flushRedis();
  }
}
