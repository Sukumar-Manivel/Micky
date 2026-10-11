// Regenerates docs/screenshots/ from the real app with realistic demo data.
// Not part of the test suite: run with `npx playwright test --config shots/shots.config.ts`.
import { execFileSync } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { PASSWORD, type Session, approveChannel, approveMedia, call, loginAdmin, register, waitForStatus } from '../support/api.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, E2E_DIR, FIXTURES_DIR, ROOT, WEB_URL } from '../support/env.js';
import { loginInUi } from '../support/fixtures.js';
import { queryDb } from '../support/stack.js';

const OUT = path.join(ROOT, 'docs', 'screenshots');
const run = Date.now().toString(36);

const CLIPS = [
  { scene: 'fire', title: 'Warehouse fire near Chennai Central', category: 'FIRE', lat: 13.0827, lng: 80.2707, place: 'Chennai Central' },
  { scene: 'bus', title: 'Bus overturned near Tambaram bridge', category: 'ACCIDENT', lat: 12.9249, lng: 80.1, place: 'Tambaram' },
  { scene: 'flood', title: 'Waterlogging on Anna Salai after heavy rain', category: 'FLOOD', lat: 13.0604, lng: 80.2496, place: 'Anna Salai, near Gemini flyover' },
  { scene: 'tree', title: 'Tree fallen across Gandhipuram main road', category: 'INFRASTRUCTURE', lat: 11.0168, lng: 76.9558, place: 'Gandhipuram, Coimbatore' },
] as const;

/** Renders a synthetic phone clip of the scene (see render_scenes.py), unique per run. */
function makeClip(i: number): string {
  const file = path.join(FIXTURES_DIR, `shot-${i}.mp4`);
  execFileSync('python3', [path.join(E2E_DIR, 'shots', 'render_scenes.py'), CLIPS[i].scene, file, `shots-${run}-${i}`], { stdio: 'inherit' });
  return file;
}

async function upload(s: Session, i: number, file: string): Promise<string> {
  const c = CLIPS[i];
  const form = new FormData();
  form.set('title', c.title);
  form.set('description', 'Filmed from across the road. Fire services arrived about ten minutes later.');
  form.set('category', c.category);
  form.set('latitude', String(c.lat));
  form.set('longitude', String(c.lng));
  form.set('locationName', c.place);
  form.set('capturedAt', new Date(Date.now() - (i + 1) * 25 * 60_000).toISOString());
  form.set('rightsConfirmed', 'true');
  form.set('file', await openAsBlob(file, { type: 'video/mp4' }), `VID_2026101${i}.mp4`);
  const res = await call<{ id: string }>('POST', '/media', { token: s.token, form });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}

const DESKTOP = { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 };
const MOBILE = { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function ctx(browser: Browser, opts: typeof DESKTOP | typeof MOBILE): Promise<BrowserContext> {
  const c = await browser.newContext({ ...opts, baseURL: WEB_URL, geolocation: { latitude: 13.0827, longitude: 80.2707 }, permissions: ['geolocation'] });
  await c.route((u) => !['localhost', '127.0.0.1'].includes(u.hostname), (r) => r.abort('blockedbyclient'));
  return c;
}

async function settle(p: Page) {
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForTimeout(1200);
}

async function shot(p: Page, name: string, fullPage = false) {
  await settle(p);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

test.describe.serial('screenshots', () => {
  test.setTimeout(600_000);
  const uploaderEmail = `priya.${run}@example.in`;
  const channelEmail = `desk.${run}@chennailive.in`;
  let ids: string[] = [];

  test('seed demo data', async () => {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    // Render first: it takes ~45 s, longer than the e2e stack's access-token lifetime.
    const files = CLIPS.map((_, i) => makeClip(i));
    await queryDb(`UPDATE users SET name = 'Micky Admin' WHERE email = $1`, [ADMIN_EMAIL]);
    const admin = await loginAdmin();
    const uploader = await register('UPLOADER', { name: 'Priya Raman', email: uploaderEmail });
    ids = [];
    // One at a time: the API caps uploads still processing per witness (review M6).
    for (let i = 0; i < CLIPS.length; i++) {
      ids.push(await upload(uploader, i, files[i]));
      await waitForStatus(uploader, ids[i], 'IN_REVIEW', 120_000);
    }
    for (const id of ids.slice(0, 3)) await approveMedia(admin, id);
    const channel = await register('CHANNEL', { name: 'Karthik S', organization: 'Chennai Live News', email: channelEmail });
    await approveChannel(admin, channel.user.id);
    await register('CHANNEL', { name: 'Meena R', organization: 'Kovai Times', email: `news.${run}@kovaitimes.in` });
    const rep = await call('POST', '/reports', {
      body: { mediaId: ids[1], reporterEmail: 'family.member@example.in', reason: 'PRIVACY', details: 'My relative is visible in this clip and did not agree to be filmed.' },
    });
    expect(rep.status).toBe(201);
  });

  test('desktop: newsroom', async ({ browser }) => {
    const c = await ctx(browser, DESKTOP);
    const p = await c.newPage();
    await p.goto('/');
    await shot(p, 'home-desktop');
    await loginInUi(p, channelEmail, PASSWORD);
    await p.goto('/newsroom');
    await shot(p, 'newsroom-feed-desktop');
    await p.getByLabel(/search/i).first().fill('Chennai');
    await p.getByRole('button', { name: 'Search' }).click();
    await shot(p, 'newsroom-search-desktop');
    await p.goto('/newsroom/map');
    await shot(p, 'newsroom-map-desktop');
    await p.goto(`/newsroom/media/${ids[1]}`);
    await p.waitForTimeout(6000); // the per-newsroom preview rendition is prepared on first view
    await shot(p, 'newsroom-media-desktop', true);
    await p.goto(`/newsroom/media/${ids[0]}`);
    await settle(p);
    await p.getByRole('button', { name: 'Buy non-exclusive licence' }).click();
    const dialog = p.getByRole('dialog', { name: 'Test payment' });
    await expect(dialog).toBeVisible();
    await shot(p, 'newsroom-mock-checkout-desktop');
    await dialog.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(p.getByText('Payment received. The licence is yours.')).toBeVisible();
    await c.close();
  });

  test('mobile: witness and newsroom', async ({ browser }) => {
    const anon = await ctx(browser, MOBILE);
    const a = await anon.newPage();
    await a.goto('/');
    await shot(a, 'home-mobile', true);
    await a.goto('/report');
    await shot(a, 'report-mobile', true);
    await anon.close();

    const w = await ctx(browser, MOBILE);
    const u = await w.newPage();
    await loginInUi(u, uploaderEmail, PASSWORD);
    await u.goto('/upload');
    await shot(u, 'upload-mobile', true);
    await u.goto('/dashboard');
    await shot(u, 'uploader-dashboard-mobile', true);
    await u.goto(`/dashboard/media/${ids[0]}`);
    await shot(u, 'uploader-media-mobile', true);
    await u.goto('/dashboard/earnings');
    await settle(u);
    await u.getByLabel('UPI ID').fill('priya.raman@okaxis');
    await u.getByLabel('Your account password').fill(PASSWORD);
    await u.getByRole('button', { name: 'Save UPI ID' }).click();
    await expect(u.getByText('UPI ID saved')).toBeVisible();
    await u.getByRole('button', { name: 'Request payout' }).click();
    await expect(u.getByText(/Payout of .* requested/)).toBeVisible();
    await u.waitForTimeout(5500); // let the toasts disappear
    await shot(u, 'uploader-earnings-mobile', true);
    await w.close();

    const n = await ctx(browser, MOBILE);
    const q = await n.newPage();
    await loginInUi(q, channelEmail, PASSWORD);
    await q.goto('/newsroom');
    await q.getByLabel(/search/i).first().fill('Chennai');
    await q.getByRole('button', { name: 'Search' }).click();
    await shot(q, 'newsroom-search-mobile', true);
    await q.goto(`/newsroom/media/${ids[2]}`);
    await q.waitForTimeout(6000);
    await shot(q, 'newsroom-media-mobile', true);
    await q.goto('/newsroom/purchases');
    await shot(q, 'newsroom-purchases-mobile', true);
    await n.close();
  });

  test('admin: desktop and mobile', async ({ browser }) => {
    const c = await ctx(browser, DESKTOP);
    const p = await c.newPage();
    await loginInUi(p, ADMIN_EMAIL, ADMIN_PASSWORD);
    await p.goto('/admin');
    await shot(p, 'admin-overview-desktop');
    await p.goto('/admin/review');
    await settle(p);
    await p.getByText(CLIPS[3].title).first().click();
    await shot(p, 'admin-review-desktop', true);
    await p.goto('/admin/channels');
    await shot(p, 'admin-channels-desktop');
    await p.goto('/admin/payouts');
    await shot(p, 'admin-payouts-desktop');
    await p.goto('/admin/reports');
    await shot(p, 'admin-reports-desktop', true);
    await c.close();

    const m = await ctx(browser, MOBILE);
    const q = await m.newPage();
    await loginInUi(q, ADMIN_EMAIL, ADMIN_PASSWORD);
    await q.goto('/admin/review');
    await shot(q, 'admin-review-mobile', true);
    await q.getByText(CLIPS[3].title).first().click();
    await shot(q, 'admin-review-item-mobile', true);
    await q.goto('/admin/channels');
    await shot(q, 'admin-channels-mobile', true);
    await m.close();
  });
});
