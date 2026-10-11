// The money path, end to end, the way real people use Micky:
//
//   witness uploads a clip → worker processes it → admin reviews the evidence and approves it
//   → a newsroom (approved by the admin) gets a live alert, finds it in the feed and on the
//   incident page, watches the protected preview, buys a licence, downloads the file (metadata removed)
//   → the witness sees the earning, adds a UPI ID and withdraws → the admin marks it paid.
//
// Three browser contexts (= three people with their own cookies) stay open for the whole
// story, so each person logs in once. The steps depend on each other: describe.serial stops
// at the first failure instead of producing a cascade of confusing errors.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { PASSWORD, uniqueEmail } from '../support/api.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from '../support/env.js';
import { loginInUi, newUserContext, registerInUi, trackPageErrors } from '../support/fixtures.js';
import { CLIPS, sha256 } from '../support/media.js';
import { queryDb } from '../support/stack.js';

test.describe.serial('money path: upload → review → licence → download → payout', () => {
  const run = Date.now().toString(36);
  const title = `Warehouse fire near Central station ${run}`;
  const organization = `Chennai Live News ${run}`;
  const uploaderEmail = uniqueEmail('witness');
  const channelEmail = uniqueEmail('desk');
  const upiId = `witness.${run}@okaxis`;

  let uploaderCtx: BrowserContext;
  let adminCtx: BrowserContext;
  let channelCtx: BrowserContext;
  let uploader: Page;
  let admin: Page;
  let channel: Page;
  const pageErrors: string[] = [];
  let mediaId = '';

  test.beforeAll(async ({ browser }) => {
    uploaderCtx = await newUserContext(browser);
    adminCtx = await newUserContext(browser);
    channelCtx = await newUserContext(browser);
    uploader = await uploaderCtx.newPage();
    admin = await adminCtx.newPage();
    channel = await channelCtx.newPage();
    for (const p of [uploader, admin, channel]) pageErrors.push(...trackPageErrors(p));
  });

  test.afterAll(async () => {
    await Promise.all([uploaderCtx?.close(), adminCtx?.close(), channelCtx?.close()]);
  });

  test('1. a witness registers and uploads a video with its location', async () => {
    await registerInUi(uploader, { kind: 'uploader', name: 'Priya Witness', email: uploaderEmail, password: PASSWORD });
    await expect(uploader).toHaveURL(/\/upload$/);

    await uploader.locator('#file').setInputFiles(CLIPS.main);
    await expect(uploader.getByLabel('Your selected video')).toBeVisible();
    await uploader.getByLabel('What happened?').fill(title);
    await uploader.getByLabel('Type of incident').selectOption('FIRE');
    await uploader.getByRole('button', { name: 'Use my location' }).click();
    // The browser shared the location the context was given (Chennai Central).
    await expect(uploader.getByText('13.08270, 80.27070')).toBeVisible();
    await uploader.getByLabel('Place name (optional)').fill('Chennai Central');
    await uploader.getByRole('checkbox', { name: /I recorded this myself/ }).check();
    await uploader.getByRole('button', { name: 'Upload footage' }).click();

    await expect(uploader.getByRole('heading', { name: 'Uploaded. Thank you.' })).toBeVisible();
    const [row] = await queryDb<{ id: string; status: string }>('SELECT id, status FROM media WHERE title = $1', [title]);
    expect(row, 'the upload is stored').toBeTruthy();
    mediaId = row.id;
  });

  test('2. the worker processes it, and the dashboard shows "In review"', async () => {
    await uploader.getByRole('link', { name: 'See my footage' }).click();
    await expect(uploader).toHaveURL(/\/dashboard$/);
    const upload = uploader.getByRole('link', { name: new RegExp(title) });
    await expect(upload).toBeVisible();
    // The dashboard polls every 10 s while something is PROCESSING; the worker needs a few seconds.
    await expect(upload.getByText('In review')).toBeVisible({ timeout: 60_000 });
  });

  test('3. a newsroom registers and waits for approval', async () => {
    await registerInUi(channel, {
      kind: 'newsroom',
      name: 'Arjun Desk',
      email: channelEmail,
      password: PASSWORD,
      organization,
    });
    await expect(channel).toHaveURL(/\/newsroom$/);
    await expect(channel.getByRole('heading', { name: 'Your newsroom is waiting for approval' })).toBeVisible();
  });

  test('4. the admin approves the newsroom', async () => {
    await loginInUi(admin, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(admin).toHaveURL(/\/admin$/);
    await admin.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Newsrooms' }).click();
    const card = admin.locator('article').filter({ hasText: organization });
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(admin.getByText(`${organization} approved`)).toBeVisible();

    // The newsroom reloads and now sees the live feed instead of the waiting page.
    await channel.reload();
    await expect(channel.getByRole('heading', { name: 'Trending now' })).toBeVisible();
    await expect(channel.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  });

  test('5. the admin reviews the verification signals and approves; the newsroom gets a live alert', async () => {
    await admin.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Review queue' }).click();
    await admin.getByRole('button', { name: new RegExp(title) }).click();
    const panel = admin.getByRole('article').filter({ has: admin.getByRole('heading', { name: title }) });

    // The evidence the reviewer decides on.
    const signals = panel.getByRole('region', { name: 'Verification signals' });
    await expect(signals.getByText(/(Low|Medium|High) risk/)).toBeVisible();
    await expect(signals.getByText('No Content Credentials', { exact: true })).toBeVisible();
    await expect(signals.getByText('The AI detector was unavailable for this file.')).toBeVisible();
    await expect(signals.getByText(/re-encoded by software/)).toBeVisible();
    await signals.getByText(/Full metadata/).click();
    await expect(signals.getByText('Lavf', { exact: false }).first()).toBeVisible();
    await expect(panel.getByText('Priya Witness', { exact: false })).toBeVisible();

    await panel.getByRole('button', { name: 'Approve…' }).click();
    await panel.getByRole('button', { name: 'Approve and put on sale' }).click();
    await expect(admin.getByText(`Approved: ${title}`)).toBeVisible();

    // Socket.IO `media.approved` reached the newsroom's open feed.
    await expect(channel.getByText(`New fire footage: ${title}`)).toBeVisible();
  });

  test('6. the newsroom finds it in the feed and on the incident page', async () => {
    const incident = channel.getByRole('link', { name: /Chennai Central/ }).first();
    await expect(incident).toBeVisible();
    // "1 clip" on a fresh database; reruns against a kept database join the same incident.
    await expect(incident).toContainText(/\d+ clips?/);
    await incident.click();
    await expect(channel).toHaveURL(/\/newsroom\/incidents\/[0-9a-f-]{36}$/);
    await expect(channel.getByRole('heading', { level: 1 })).toContainText('Chennai Central');
    await channel.getByRole('link', { name: new RegExp(title) }).click();
    await expect(channel).toHaveURL(new RegExp(`/newsroom/media/${mediaId}$`));
  });

  test('7. the preview streams as encrypted HLS, and nothing can be downloaded before paying', async () => {
    // Hold the video segments until the player is checked, so the checks never race playback.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const segmentUrls: string[] = [];
    await channel.route(/\/stream\/[^/]+\/seg_\d+\.ts$/, async (route) => {
      segmentUrls.push(route.request().url());
      await gate;
      await route.continue();
    });

    // Leave the page first, so only the fresh page's requests are matched below.
    const mediaUrl = channel.url();
    await channel.goto('about:blank');
    // The first view may answer 202 "preparing" while the worker burns this newsroom's name
    // into its own copy of the preview; the player then asks again until it gets the session.
    const session = channel.waitForResponse(
      (r) => r.url().endsWith(`/market/media/${mediaId}/preview`) && r.status() === 200,
      { timeout: 60_000 },
    );
    const playlist = channel.waitForResponse((r) => /\/stream\/[^/]+\/index\.m3u8$/.test(r.url()));
    const key = channel.waitForResponse((r) => /\/stream\/[^/]+\/key\.bin$/.test(r.url()));
    const segment = channel.waitForResponse((r) => /\/stream\/[^/]+\/seg_\d+\.ts$/.test(r.url()));
    await channel.goto(mediaUrl);

    const preview = (await (await session).json()) as { kind: string; watermarkText: string };
    expect(preview.kind).toBe('hls');
    expect(preview.watermarkText).toContain(organization);
    const m3u8 = await playlist;
    expect(m3u8.status()).toBe(200);
    expect(m3u8.headers()['content-type']).toContain('mpegurl');
    const text = await m3u8.text();
    expect(text).toContain('#EXTM3U');
    // The key and the segments each get their own short-lived token, bound to this viewer.
    expect(text).toMatch(/#EXT-X-KEY:METHOD=AES-128,URI="\.\.\/[\w-]+\.[\w-]+\/key\.bin"/);
    expect((await key).status()).toBe(200);
    // At most 40% of the 6 s clip reaches the browser before payment.
    const previewSeconds = [...text.matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(previewSeconds).toBeLessThanOrEqual(2.5);

    // The protected player: no download button, and the viewer's organisation over the picture.
    const video = channel.getByLabel(`Preview of ${title}`);
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute('controlslist', /nodownload/);
    await expect(video).toHaveAttribute('disablepictureinpicture', '');
    await expect(channel.getByText(preview.watermarkText).first()).toBeAttached();

    release();
    expect((await segment).status()).toBe(200);

    // Play it, if this browser can decode H.264/AAC at all. Playwright's bundled Chromium
    // cannot (no proprietary codecs), so there the player must give up cleanly and say so,
    // instead of re-downloading the same segment forever (regression: it did ~9 times/s).
    const canPlayH264 = await channel.evaluate(() => MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001e,mp4a.40.2"'));
    if (canPlayH264) {
      await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    } else {
      await expect(channel.getByText('This browser cannot play the preview video.', { exact: false })).toBeVisible();
      await expect(channel.getByRole('button', { name: 'Try again' })).toBeVisible();
    }
    await channel.waitForTimeout(3_000);
    // The clip has 2 segments; a bounded number of retries is fine, a loop is not.
    expect(segmentUrls.length, `segment requests: ${segmentUrls.length}`).toBeLessThanOrEqual(6);
    await channel.unroute(/\/stream\/[^/]+\/seg_\d+\.ts$/);

    // No way to the original before payment.
    await expect(channel.getByRole('button', { name: 'Download original' })).toHaveCount(0);
    await expect(channel.locator('a[href*="/files/download/"]')).toHaveCount(0);
    await expect(channel.getByRole('button', { name: 'Buy non-exclusive licence' })).toBeEnabled();
    await expect(channel.getByRole('button', { name: 'Buy exclusive licence' })).toBeEnabled();
  });

  test('8. the newsroom buys a licence through the mock checkout and downloads the original', async () => {
    await channel.getByRole('button', { name: 'Buy non-exclusive licence' }).click();
    const dialog = channel.getByRole('dialog', { name: 'Test payment' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('₹1,500');
    await dialog.getByRole('button', { name: 'Simulate successful payment' }).click();
    await expect(channel.getByText('Payment received. The licence is yours.')).toBeVisible();

    const download = channel.waitForEvent('download');
    await channel.getByRole('button', { name: 'Download original' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Warehouse-fire-near-Central-station-[a-z0-9]+\.mp4$/);
    const saved = await file.path();
    const bytes = sha256(saved);
    // The buyer gets the delivery copy: same pictures and sound, but without the witness's
    // GPS and device tags (review H3). Its checksum is what the API publishes for it.
    const [{ checksum, delivery }] = await queryDb<{ checksum: string; delivery: string }>(
      `SELECT m.checksum, v.metadata->'delivery'->>'sha256' AS delivery
         FROM media m JOIN verifications v ON v.media_id = m.id WHERE m.id = $1`,
      [mediaId],
    );
    expect(bytes, 'downloaded bytes = the delivery copy, as checksummed by the worker').toBe(delivery);
    expect(bytes, 'not the untouched upload').not.toBe(checksum);
    expect(checksum).toBe(sha256(CLIPS.main));
    await expect(channel.getByTestId('file-sha256')).toHaveText(delivery);
    const tags = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', saved]).toString(),
    ) as { format: { tags?: Record<string, string>; duration: string }; streams: { codec_type: string }[] };
    expect(Object.keys(tags.format.tags ?? {})).not.toContain('location');
    expect(Object.keys(tags.format.tags ?? {})).not.toContain('comment');
    expect(tags.streams.map((st) => st.codec_type).sort()).toEqual(['audio', 'video']);
    expect(Number(tags.format.duration)).toBeGreaterThan(5.5); // the whole clip, not the preview

    // It is listed under Purchases too.
    await channel.goto('/newsroom/purchases');
    await expect(channel.getByText(title)).toBeVisible();
  });

  test('9. the witness sees the earning, adds a UPI ID and requests a payout', async () => {
    await uploader.goto('/dashboard');
    const upload = uploader.getByRole('link', { name: new RegExp(title) });
    await expect(upload.getByText('On sale')).toBeVisible();
    // ₹1,500 sale, 30 % platform fee: the witness earns ₹1,050.
    await expect(upload).toContainText('₹1,050');

    await uploader.getByRole('link', { name: 'Withdraw and history' }).click();
    await expect(uploader.getByRole('heading', { name: 'Earnings' })).toBeVisible();
    await expect(uploader.getByRole('table').filter({ hasText: organization })).toContainText('₹1,050');

    await uploader.getByLabel('UPI ID').fill(upiId);
    await uploader.getByLabel('Your account password').fill(PASSWORD);
    await uploader.getByRole('button', { name: 'Save UPI ID' }).click();
    await expect(uploader.getByText('UPI ID saved')).toBeVisible();

    await expect(uploader.getByLabel('Amount (₹)')).toHaveValue('1050');
    await uploader.getByRole('button', { name: 'Request payout' }).click();
    await expect(uploader.getByText('Payout of ₹1,050 requested')).toBeVisible();
    const payouts = uploader.getByRole('region', { name: 'Payouts' });
    await expect(payouts.getByRole('row').filter({ hasText: upiId })).toContainText('Requested');
  });

  test('10. the admin marks the payout paid, and the witness sees it', async () => {
    await admin.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Payouts' }).click();
    const card = admin.locator('article').filter({ hasText: upiId });
    await expect(card).toContainText('₹1,050');
    await card.getByRole('button', { name: 'Mark as paid…' }).click();
    await card.getByLabel('UPI transaction reference (UTR)').fill('412345678901');
    await card.getByRole('button', { name: 'Confirm ₹1,050 paid' }).click();
    await expect(admin.getByText('Payout of ₹1,050 marked as paid')).toBeVisible();

    await uploader.reload();
    const payouts = uploader.getByRole('region', { name: 'Payouts' });
    await expect(payouts.getByRole('row').filter({ hasText: upiId })).toContainText('Paid');
    await expect(payouts.getByRole('row').filter({ hasText: upiId })).toContainText('412345678901');
    const paidOut = uploader.locator('dl > div').filter({ hasText: 'Paid out' });
    await expect(paidOut).toContainText('₹1,050');
    // "Available" (was "Balance") since sale credits can be on hold before payout.
    const available = uploader.locator('dl > div').filter({ hasText: 'Available' });
    await expect(available).toContainText('₹0');
  });

  test('no page crashed along the way', () => {
    expect(pageErrors).toEqual([]);
  });
});
