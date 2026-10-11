// Start or stop the e2e stack by hand, for exploring or debugging a failing test:
//   npm run stack:up     fresh DB + Redis, then verifier, API, worker and web (in the background)
//   npm run stack:down   stop them (add E2E_DROP_DB=1 to drop the database too)
// Then run the tests against it with E2E_EXTERNAL_STACK=1 npm test.
import globalSetup from '../global-setup.js';
import globalTeardown from '../global-teardown.js';
import { API, WEB_URL } from '../support/env.js';

const cmd = process.argv[2];
if (cmd === 'up') {
  await globalSetup();
  console.log(`Stack is up: web ${WEB_URL}, API ${API}. Logs in e2e/.stack/*.log`);
} else if (cmd === 'down') {
  await globalTeardown();
  console.log('Stack stopped');
} else {
  console.error('Usage: tsx scripts/stack.ts up|down');
  process.exit(1);
}
