// Config for regenerating docs/screenshots/ (see screens.spec.ts). Reuses the e2e stack.
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

export default defineConfig({
  ...base,
  testDir: '.',
  globalSetup: '../global-setup.ts',
  globalTeardown: '../global-teardown.ts',
  reporter: [['list']],
  timeout: 600_000,
});
