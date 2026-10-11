// What must NOT be possible. Each test arranges its own users and media through the API
// (fast, and not what is being tested), then checks the behaviour in the browser and, where
// the browser only hides something, also checks that the API refuses it.
import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  approveChannel,
  approveMedia,
  call,
  loginAdmin,
  register,
  uniqueEmail,
  uploadVideo,
  waitForStatus,
} from '../support/api.js';
import { loginInUi, newUserContext, registerInUi } from '../support/fixtures.js';
import { CLIPS } from '../support/media.js';

test('a newsroom cannot reach the admin pages, in the browser or through the API', async ({ browser }) => {
  const admin = await loginAdmin();
  const email = uniqueEmail('desk-admin-probe');
  const channel = await register('CHANNEL', { email, organization: 'Curious News' });
  await approveChannel(admin, channel.user.id);

  const ctx = await newUserContext(browser);
  const page = await ctx.newPage();
  await loginInUi(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/newsroom$/);

  for (const path of ['/admin', '/admin/review', '/admin/payouts']) {
    await page.goto(path);
    // The client-side guard sends a newsroom back to its own home...
    await expect(page).toHaveURL(/\/newsroom$/);
    await expect(page.getByRole('heading', { name: 'Review queue' })).toHaveCount(0);
  }
  // ...but the real protection is the API.
  for (const route of ['/admin/stats', '/admin/review-queue', '/admin/payouts', '/admin/channels']) {
    expect((await call('GET', route, { token: channel.token })).status, route).toBe(403);
  }
  expect((await call('POST', `/admin/channels/${channel.user.id}/approve`, { token: channel.token })).status).toBe(403);
  await ctx.close();
});

test('an unapproved newsroom sees the pending state and no footage', async ({ browser }) => {
  const ctx = await newUserContext(browser);
  const page = await ctx.newPage();
  const email = uniqueEmail('desk-pending');
  // Keep the access token the browser receives, to ask the API directly below (no extra login).
  const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
  await registerInUi(page, { kind: 'newsroom', name: 'Meera Pending', email, password: PASSWORD, organization: 'Not Yet News' });
  const { accessToken: token } = (await (await registered).json()) as { accessToken: string };

  await expect(page).toHaveURL(/\/newsroom$/);
  await expect(page.getByRole('heading', { name: 'Your newsroom is waiting for approval' })).toBeVisible();
  await expect(page.locator('#main').getByText('Not Yet News')).toBeVisible();
  // Every newsroom page shows the same, including deep links.
  for (const path of ['/newsroom/map', '/newsroom/purchases', `/newsroom/media/${crypto.randomUUID()}`]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Your newsroom is waiting for approval' })).toBeVisible();
  }
  // And the API refuses the marketplace and checkout.
  expect((await call('GET', '/market/media', { token })).status).toBe(403);
  expect((await call('GET', '/market/incidents', { token })).status).toBe(403);
  expect(
    (await call('POST', '/orders', { token, body: { mediaId: crypto.randomUUID(), licenseType: 'NON_EXCLUSIVE' } })).status,
  ).toBe(403);
  await ctx.close();
});

test('a duplicate upload and a fake video are rejected with a clear message', async ({ browser }) => {
  const email = uniqueEmail('witness-dup');
  const uploader = await register('UPLOADER', { email, name: 'Ravi Twice' });
  await uploadVideo(uploader, CLIPS.duplicate, 'First upload of this clip');

  const ctx = await newUserContext(browser);
  const page = await ctx.newPage();
  await loginInUi(page, email, PASSWORD);

  async function tryUpload(file: string, title: string) {
    await page.goto('/upload');
    await page.locator('#file').setInputFiles(file);
    await page.getByLabel('What happened?').fill(title);
    await page.getByLabel('Type of incident').selectOption('FIRE');
    await page.getByRole('button', { name: 'Use my location' }).click();
    await page.getByRole('checkbox', { name: /I recorded this myself/ }).check();
    await page.getByRole('button', { name: 'Upload footage' }).click();
  }

  await tryUpload(CLIPS.duplicate, 'Same clip uploaded again');
  await expect(page.getByRole('alert').filter({ hasText: 'This exact file has already been uploaded to FirstFrame.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Uploaded. Thank you.' })).toHaveCount(0);

  // A text file renamed .mp4 passes the browser's check (it trusts the extension) but not the API's magic bytes.
  await tryUpload(CLIPS.fake, 'Text file pretending to be a video');
  await expect(page.getByRole('alert').filter({ hasText: 'This file type is not supported.' })).toBeVisible();

  const mine = await call<{ total: number }>('GET', '/me/media', { token: uploader.token });
  expect(mine.body.total, 'only the first upload exists').toBe(1);
  await ctx.close();
});

test('an exclusive licence stops a second sale', async ({ browser }) => {
  const admin = await loginAdmin();
  const uploader = await register('UPLOADER', { name: 'Sana Exclusive' });
  const title = `Flooded underpass, exclusive ${Date.now().toString(36)}`;
  const { id: mediaId } = await uploadVideo(uploader, CLIPS.exclusive, title);
  await waitForStatus(uploader, mediaId, 'IN_REVIEW');
  await approveMedia(admin, mediaId);

  const firstEmail = uniqueEmail('desk-first');
  const secondEmail = uniqueEmail('desk-second');
  const first = await register('CHANNEL', { email: firstEmail, organization: 'First To Buy News' });
  const second = await register('CHANNEL', { email: secondEmail, organization: 'Too Late News' });
  await approveChannel(admin, first.user.id);
  await approveChannel(admin, second.user.id);

  // The second newsroom opens the page while both licences are still for sale (a stale page).
  const secondCtx = await newUserContext(browser);
  const late = await secondCtx.newPage();
  await loginInUi(late, secondEmail, PASSWORD);
  await late.goto(`/newsroom/media/${mediaId}`);
  await expect(late.getByRole('button', { name: 'Buy non-exclusive licence' })).toBeEnabled();

  // The first newsroom buys the exclusive licence.
  const firstCtx = await newUserContext(browser);
  const buyer = await firstCtx.newPage();
  await loginInUi(buyer, firstEmail, PASSWORD);
  await buyer.goto(`/newsroom/media/${mediaId}`);
  await buyer.getByRole('button', { name: 'Buy exclusive licence' }).click();
  await buyer.getByRole('dialog', { name: 'Test payment' }).getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(buyer.getByText('Payment received. The licence is yours.')).toBeVisible();
  await expect(buyer.getByRole('button', { name: 'Download original' })).toBeVisible();

  // The stale page tries to buy anyway: the API says no, and the page explains why.
  await late.getByRole('button', { name: 'Buy non-exclusive licence' }).click();
  await expect(late.getByRole('alert').filter({ hasText: 'licensed exclusively to another organisation' })).toBeVisible();
  await expect(late.getByRole('dialog', { name: 'Test payment' })).toHaveCount(0);

  // A fresh page offers nothing to buy.
  await late.reload();
  await expect(late.getByText('Not available: licensed exclusively.')).toBeVisible();
  await expect(late.getByText('Not available: already licensed to a newsroom.')).toBeVisible();
  await expect(late.getByRole('button', { name: /^Buy / })).toHaveCount(0);
  await expect(late.getByRole('button', { name: 'Download original' })).toHaveCount(0);

  // Same through the API, for both licence types.
  for (const licenseType of ['NON_EXCLUSIVE', 'EXCLUSIVE']) {
    const res = await call<{ message: string }>('POST', '/orders', { token: second.token, body: { mediaId, licenseType } });
    expect(res.status, licenseType).toBe(409);
  }
  // Exactly one paid order, and one credit for the witness.
  const sales = await call<{ total: number }>('GET', '/me/sales', { token: uploader.token });
  expect(sales.body.total).toBe(1);
  await Promise.all([firstCtx.close(), secondCtx.close()]);
});
