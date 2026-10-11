// Browser end-to-end tests for FirstFrame. See README.md in this folder.
//
// The tests share one stack and one database (booted by global-setup.ts), and the money
// path is a story whose steps depend on each other, so everything runs in one worker,
// in file order. Each file uses its own users, so files never depend on each other.
import { defineConfig, devices } from '@playwright/test';
import { WEB_URL } from './support/env.js';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  // No automatic retries: a retried money-path step would hide a real bug (and re-register
  // users against the API's 10/min rate limit). Flakiness is designed out instead: see README.
  retries: 0,
  forbidOnly: CI,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
});
