// Shared Playwright helpers: hermetic browser contexts and small UI actions used by several specs.
import { type Browser, type BrowserContext, type Page, expect } from '@playwright/test';
import { CLIP_LOCATION } from './media.js';
import { WEB_URL } from './env.js';

/**
 * A fresh browser context (its own cookies = its own logged-in user), with:
 * - geolocation granted and set to where the clips were filmed ("Use my location" works);
 * - every request to the outside world blocked (map tiles from openstreetmap.org), so the
 *   tests never depend on the internet and never wait on a slow third party.
 */
export async function newUserContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    geolocation: { latitude: CLIP_LOCATION.lat, longitude: CLIP_LOCATION.lng },
    permissions: ['geolocation'],
    acceptDownloads: true,
  });
  await context.route(
    (url) => !['localhost', '127.0.0.1'].includes(url.hostname),
    (route) => route.abort('blockedbyclient'),
  );
  return context;
}

/** Collects uncaught page errors so a test can assert the app never crashed. */
export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

export async function registerInUi(
  page: Page,
  opts: { kind: 'uploader' | 'newsroom'; name: string; email: string; password: string; organization?: string },
) {
  await page.goto('/register');
  if (opts.kind === 'newsroom') await page.getByRole('radio', { name: /I’m a newsroom/ }).check();
  await page.getByLabel(opts.kind === 'newsroom' ? 'Your name' : 'Name', { exact: true }).fill(opts.name);
  if (opts.organization) await page.getByLabel('Organisation').fill(opts.organization);
  await page.getByLabel('Email').fill(opts.email);
  await page.getByLabel('Password').fill(opts.password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

export async function loginInUi(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
