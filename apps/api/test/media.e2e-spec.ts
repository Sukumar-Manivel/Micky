// E2E tests for uploads (MediaModule) and processing (worker: MediaProcessingService / MediaProcessor).
//
// Fixtures are generated with FFmpeg at test time (no binaries in git).
// The verifier is replaced by a tiny HTTP server in this file, so we control
// its answers (AI score, pHashes) and can simulate it being down.
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AppConfig } from '../src/config/app-config.js';
import { incidents, media, orders, verifications } from '../src/db/schema.js';
import { MediaProcessingService } from '../src/processing/media-processing.service.js';
import { MediaProcessor } from '../src/processing/media.processor.js';
import { MEDIA_QUEUE } from '../src/processing/processing.constants.js';
import { VerifierUnavailableError } from '../src/processing/verifier.client.js';
import { StorageService, storageKeys } from '../src/storage/storage.service.js';
import { createWorkerContext } from '../src/worker.module.js';
import { auth, createAdmin, db, resetDb, startApp } from './helpers.js';
import { createUser, KOCHI, type TestUser } from './market.fixtures.js';

// ---------- Mock verifier ----------

interface MockVerifier {
  mode: 'ok' | 'down' | 'unauthorized';
  /** pHash returned for every frame; null = a random hash per request (no duplicates). */
  phash: string | null;
  aiScore: number;
  requests: { token: string | undefined; mediaType: string; frames: number; hasOriginal: boolean }[];
}

const verifier: MockVerifier = { mode: 'ok', phash: null, aiScore: 0.12, requests: [] };

function startMockVerifier(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (verifier.mode === 'down') {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"detail":"model warming up"}');
        return;
      }
      if (verifier.mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"bad token"}');
        return;
      }
      // Let the WHATWG Response class parse the multipart body for us.
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': String(req.headers['content-type']) },
      }).formData();
      const frames = form.getAll('frames').length;
      verifier.requests.push({
        token: req.headers['x-internal-token'] as string | undefined,
        mediaType: String(form.get('media_type')),
        frames,
        hasOriginal: form.has('original'),
      });
      const hash = verifier.phash ?? randomBytes(8).toString('hex');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          ai: {
            available: true,
            score: verifier.aiScore,
            model: 'mock-detector',
            frames_scored: frames,
            frame_scores: Array.from({ length: frames }, () => verifier.aiScore),
          },
          c2pa: { status: 'absent', issuer: null, claim_generator: null },
          phash: Array.from({ length: frames }, () => hash),
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    }),
  );
}

// ---------- Fixtures ----------

let fixtureDir: string;
const fx = {} as Record<'video' | 'video2' | 'portrait' | 'photo' | 'png' | 'notMedia' | 'corruptMp4' | 'bigPhoto', string>;

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args]);
}

async function makeFixtures() {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'ff-media-e2e-'));
  const f = (name: string) => path.join(fixtureDir, name);
  fx.video = f('clip.mp4');
  // 3 s test pattern with a sine tone. GPS tag = Delhi, far from the claimed Kochi.
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=15:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-metadata', 'location=+28.6139+077.2090/',
    fx.video,
  ]);
  fx.video2 = f('other.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', 'mandelbrot=size=320x240:rate=15', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', fx.video2,
  ]);
  fx.portrait = f('portrait.mov');
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=240x426:rate=10', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', fx.portrait,
  ]);
  fx.photo = f('photo.jpg');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x480', '-frames:v', '1', fx.photo]);
  fx.png = f('photo.png');
  ffmpeg(['-f', 'lavfi', '-i', 'smptebars=size=300x200', '-frames:v', '1', fx.png]);

  fx.notMedia = f('evil.mp4'); // the name says mp4, the bytes say HTML
  await writeFile(fx.notMedia, '<!doctype html><script>alert(1)</script>'.repeat(10));
  fx.corruptMp4 = f('corrupt.mp4'); // valid mp4 magic bytes, garbage after
  await writeFile(
    fx.corruptMp4,
    Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), randomBytes(4096)]),
  );
  fx.bigPhoto = f('big.jpg'); // JPEG magic + 26 MB: over the 25 MB photo limit, under the video limit
  await writeFile(fx.bigPhoto, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(26 * 1024 * 1024)]));
}

// ---------- Helpers ----------

let app: NestExpressApplication;
let worker: INestApplicationContext;
let processing: MediaProcessingService;
let queue: Queue;
let server: Server;
let uploadTmpDir: string;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function validFields(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    title: 'Fire at the Marine Drive market',
    description: 'Shot from across the road',
    category: 'FIRE',
    latitude: String(KOCHI.lat),
    longitude: String(KOCHI.lng),
    locationName: 'Marine Drive, Kochi',
    capturedAt: hoursAgo(1),
    rightsConfirmed: 'true',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

function upload(token: string | null, file: string | null, fields: Record<string, string> = validFields()) {
  let req = request(app.getHttpServer()).post('/api/v1/media');
  if (token) req = req.set(auth(token));
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  if (file) req = req.attach('file', file);
  return req;
}

/** Media created by this file, so afterAll can delete their files from test storage. */
const createdIds: string[] = [];

async function uploadOk(user: TestUser, file: string, fields?: Record<string, string>) {
  const res = await upload(user.accessToken, file, fields);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  createdIds.push(res.body.id);
  return res.body as { id: string; status: string; type: string };
}

async function loadMedia(id: string) {
  return (await db(app).query.media.findFirst({ where: eq(media.id, id) }))!;
}

async function loadVerification(id: string) {
  return db(app).query.verifications.findFirst({ where: eq(verifications.mediaId, id) });
}

/** Temp uploads are removed asynchronously at the end of the request; give it a moment. */
async function expectTmpUploadsEmpty() {
  for (let i = 0; i < 20; i++) {
    const left = existsSync(uploadTmpDir) ? await readdir(uploadTmpDir) : [];
    if (left.length === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(await readdir(uploadTmpDir)).toEqual([]);
}

async function insertPaidOrder(mediaId: string) {
  const channel = await createUser(app, 'CHANNEL', { channelStatus: 'APPROVED' });
  await db(app).insert(orders).values({
    buyerId: channel.user.id,
    mediaId,
    licenseType: 'NON_EXCLUSIVE',
    amount: 150000,
    platformFee: 45000,
    uploaderShare: 105000,
    status: 'PAID',
    provider: 'mock',
    providerOrderId: `mock_${randomUUID()}`,
    paidAt: new Date(),
  });
}

// ---------- Lifecycle ----------

beforeAll(async () => {
  await makeFixtures();
  const mock = await startMockVerifier();
  server = mock.server;
  // AppConfig reads the environment when the app is created, so set it first.
  process.env.VERIFIER_URL = mock.url;
  app = await startApp();
  worker = await createWorkerContext();
  processing = worker.get(MediaProcessingService);
  queue = worker.get<Queue>(getQueueToken(MEDIA_QUEUE));
  uploadTmpDir = path.resolve(app.get(AppConfig).uploadTmpDir);
  await queue.obliterate({ force: true });
}, 60_000);

afterAll(async () => {
  // Real HLS segments are named *.ts; left in ./tmp they would confuse `tsc` (see the final report).
  const storage = app?.get(StorageService);
  for (const id of createdIds) {
    await storage?.deletePrefix(storageKeys.previewPrefix(id));
    await storage?.deletePrefix(`originals/${id}`);
  }
  await worker?.close();
  await app?.close();
  await new Promise((r) => server?.close(r));
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDb(app);
  verifier.mode = 'ok';
  verifier.phash = null;
  verifier.aiScore = 0.12;
  verifier.requests = [];
});

// =====================================================================

describe('POST /media: access and validation', () => {
  it('requires an UPLOADER (401 without a token, 403 for a channel), before storing anything', async () => {
    await upload(null, fx.photo).expect(401);
    const channel = await createUser(app, 'CHANNEL', { channelStatus: 'APPROVED' });
    await upload(channel.accessToken, fx.photo).expect(403);
    await expectTmpUploadsEmpty();
  });

  it('requires a file', async () => {
    const u = await createUser(app, 'UPLOADER');
    const res = await upload(u.accessToken, null).expect(400);
    expect(res.body.message).toBe('file is required');
  });

  it.each([
    ['a short title', { title: 'Fire' }],
    ['a missing title', { title: undefined }],
    ['an unknown category', { category: 'ALIENS' }],
    ['latitude out of range', { latitude: '91' }],
    ['latitude not a number', { latitude: 'north' }],
    ['an empty longitude', { longitude: '' }],
    ['a description over 2000 characters', { description: 'x'.repeat(2001) }],
    ['capturedAt not a date', { capturedAt: 'yesterday' }],
    ['capturedAt in the future', { capturedAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ['capturedAt over 30 days ago', { capturedAt: hoursAgo(31 * 24) }],
    ['a price below ₹100', { priceNonExclusive: '9999' }],
    ['a price over ₹1,00,000', { priceExclusive: '10000001' }],
    ['a fractional price', { priceNonExclusive: '15000.5' }],
    ['exclusive cheaper than non-exclusive', { priceNonExclusive: '300000', priceExclusive: '200000' }],
    ['rights not confirmed', { rightsConfirmed: undefined }],
    ['rights "false"', { rightsConfirmed: 'false' }],
    ['an unknown field', { uploaderId: randomUUID() }],
  ])('rejects %s with 400 and removes the temp file', async (_name, overrides) => {
    const u = await createUser(app, 'UPLOADER');
    await upload(u.accessToken, fx.photo, validFields(overrides)).expect(400);
    await expectTmpUploadsEmpty();
    expect(await db(app).select().from(media)).toHaveLength(0);
  });

  it('accepts capturedAt slightly in the future (clock drift allowance)', async () => {
    const u = await createUser(app, 'UPLOADER');
    await uploadOk(u, fx.photo, validFields({ capturedAt: new Date(Date.now() + 2 * 60_000).toISOString() }));
  });

  it('checks the real file type from magic bytes, not the name (415)', async () => {
    const u = await createUser(app, 'UPLOADER');
    const res = await upload(u.accessToken, fx.notMedia).expect(415);
    expect(res.body.message).toMatch(/Unsupported file type/);
    await expectTmpUploadsEmpty();
  });

  it('applies the 25 MB photo limit after detecting the type (413)', async () => {
    const u = await createUser(app, 'UPLOADER');
    await upload(u.accessToken, fx.bigPhoto).expect(413);
    await expectTmpUploadsEmpty();
  });
});

describe('POST /media: success and duplicates', () => {
  it('stores the original, creates a PROCESSING row and enqueues a job', async () => {
    const u = await createUser(app, 'UPLOADER');
    const body = await uploadOk(u, fx.video);

    expect(body).toMatchObject({
      type: 'VIDEO',
      status: 'PROCESSING',
      title: 'Fire at the Marine Drive market',
      description: 'Shot from across the road',
      category: 'FIRE',
      latitude: KOCHI.lat,
      longitude: KOCHI.lng,
      locationName: 'Marine Drive, Kochi',
      priceNonExclusive: 150000, // video defaults
      priceExclusive: 500000,
      exclusiveSold: false,
      durationSec: null,
      thumbnailUrl: null,
      reviewNote: null,
      processingError: null,
      salesCount: 0,
      earned: 0,
      verification: null,
    });
    // Exactly the MediaOwnerView keys, nothing internal (originalKey, checksum, uploaderId...).
    expect(Object.keys(body).sort()).toEqual(
      [
        'id', 'type', 'status', 'title', 'description', 'category', 'latitude', 'longitude', 'locationName',
        'capturedAt', 'createdAt', 'durationSec', 'width', 'height', 'priceNonExclusive', 'priceExclusive',
        'exclusiveSold', 'thumbnailUrl', 'reviewNote', 'processingError', 'salesCount', 'earned', 'verification',
      ].sort(),
    );

    const row = await loadMedia(body.id);
    expect(row).toMatchObject({
      uploaderId: u.user.id,
      mimeType: 'video/mp4',
      originalKey: storageKeys.original(body.id, '.mp4'),
      originalName: 'clip.mp4',
      geohash: expect.stringMatching(/^[0-9a-z]{6}$/),
    });
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
    const stored = path.resolve(app.get(AppConfig).storageLocalDir, row.originalKey);
    expect(await readFile(stored)).toEqual(await readFile(fx.video));

    const job = await queue.getJob(body.id);
    expect(job?.name).toBe('process-media');
    expect(job?.data).toEqual({ mediaId: body.id });
    expect(job?.opts.attempts).toBe(4);
    await expectTmpUploadsEmpty();
  });

  it('uses photo default prices and accepts custom prices', async () => {
    const u = await createUser(app, 'UPLOADER');
    const photo = await uploadOk(u, fx.photo);
    expect(photo).toMatchObject({ type: 'PHOTO', priceNonExclusive: 50000, priceExclusive: 200000 });
    const png = await uploadOk(u, fx.png, validFields({ priceNonExclusive: '30000', priceExclusive: '30000' }));
    expect(png).toMatchObject({ priceNonExclusive: 30000, priceExclusive: 30000 });
  });

  it('rejects the same file twice with 409, whoever uploads it', async () => {
    const a = await createUser(app, 'UPLOADER');
    const b = await createUser(app, 'UPLOADER');
    await uploadOk(a, fx.photo);
    const again = await upload(b.accessToken, fx.photo).expect(409);
    expect(again.body.message).toBe('This file has already been uploaded');
    expect(await db(app).select().from(media)).toHaveLength(1);
    await expectTmpUploadsEmpty();
  });

  it('lets two simultaneous uploads of one file through only once', async () => {
    const a = await createUser(app, 'UPLOADER');
    const originalsDir = path.resolve(app.get(AppConfig).storageLocalDir, 'originals');
    const before = existsSync(originalsDir) ? (await readdir(originalsDir)).length : 0;
    const results = await Promise.all([upload(a.accessToken, fx.video2), upload(a.accessToken, fx.video2)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db(app).select().from(media)).toHaveLength(1);
    // If the loser had already copied its file into storage, that copy was deleted again.
    expect((await readdir(originalsDir)).length).toBe(before + 1);
  });

  it('allows re-uploading a file whose earlier upload FAILED', async () => {
    const u = await createUser(app, 'UPLOADER');
    const first = await uploadOk(u, fx.photo);
    await db(app).update(media).set({ status: 'FAILED' }).where(eq(media.id, first.id));
    await uploadOk(u, fx.photo);
  });
});

describe('Uploader media: list, read, edit, remove', () => {
  it('lists only the caller\'s media, newest first, with a status filter', async () => {
    const a = await createUser(app, 'UPLOADER');
    const b = await createUser(app, 'UPLOADER');
    const first = await uploadOk(a, fx.photo);
    const second = await uploadOk(a, fx.png);
    await uploadOk(b, fx.video);
    await db(app).update(media).set({ status: 'IN_REVIEW' }).where(eq(media.id, first.id));

    const all = await request(app.getHttpServer()).get('/api/v1/me/media').set(auth(a.accessToken)).expect(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(all.body.items.map((m: { id: string }) => m.id)).toEqual([second.id, first.id]);

    const filtered = await request(app.getHttpServer())
      .get('/api/v1/me/media?status=IN_REVIEW&pageSize=5')
      .set(auth(a.accessToken))
      .expect(200);
    expect(filtered.body).toMatchObject({ pageSize: 5, total: 1, items: [{ id: first.id }] });

    await request(app.getHttpServer()).get('/api/v1/me/media?status=NOPE').set(auth(a.accessToken)).expect(400);
  });

  it('returns 404 for someone else\'s media on every route, and 400 for a malformed id', async () => {
    const owner = await createUser(app, 'UPLOADER');
    const other = await createUser(app, 'UPLOADER');
    const item = await uploadOk(owner, fx.photo);
    const s = app.getHttpServer();
    await request(s).get(`/api/v1/me/media/${item.id}`).set(auth(owner.accessToken)).expect(200);
    await request(s).get(`/api/v1/me/media/${item.id}`).set(auth(other.accessToken)).expect(404);
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(other.accessToken)).send({ title: 'Hijacked title' }).expect(404);
    await request(s).delete(`/api/v1/me/media/${item.id}`).set(auth(other.accessToken)).expect(404);
    await request(s).get('/api/v1/me/media/not-a-uuid').set(auth(owner.accessToken)).expect(400);
    expect((await loadMedia(item.id)).title).toBe('Fire at the Marine Drive market');
  });

  it('is not available to channels', async () => {
    const channel = await createUser(app, 'CHANNEL', { channelStatus: 'APPROVED' });
    await request(app.getHttpServer()).get('/api/v1/me/media').set(auth(channel.accessToken)).expect(403);
  });

  it('PATCH edits title, description and prices', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/me/media/${item.id}`)
      .set(auth(u.accessToken))
      .send({ title: '  Market fire, Kochi  ', description: '', priceNonExclusive: 80000, priceExclusive: 300000 })
      .expect(200);
    expect(res.body).toMatchObject({
      id: item.id,
      title: 'Market fire, Kochi',
      description: null,
      priceNonExclusive: 80000,
      priceExclusive: 300000,
    });
  });

  it('PATCH validates prices (range, exclusive ≥ non-exclusive, also against the stored price)', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo); // 50000 / 200000
    const s = app.getHttpServer();
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ priceNonExclusive: 50 }).expect(400);
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ priceNonExclusive: 250000 }).expect(400);
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ title: 'abc' }).expect(400);
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ status: 'APPROVED' }).expect(400);
  });

  it('PATCH: prices are locked after a sale (409), title edits still work', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    await insertPaidOrder(item.id);
    const s = app.getHttpServer();
    const res = await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ priceExclusive: 900000 }).expect(409);
    expect(res.body.message).toMatch(/sold/);
    // The web form resends unchanged prices along with a new title: that is fine.
    const ok = await request(s)
      .patch(`/api/v1/me/media/${item.id}`)
      .set(auth(u.accessToken))
      .send({ title: 'Updated title only', priceNonExclusive: 50000, priceExclusive: 200000 })
      .expect(200);
    expect(ok.body).toMatchObject({ title: 'Updated title only', salesCount: 1, earned: 105000 });
  });

  it('DELETE sets REMOVED (204), is idempotent, and blocks later edits', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    const s = app.getHttpServer();
    await request(s).delete(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(204);
    expect((await loadMedia(item.id)).status).toBe('REMOVED');
    await request(s).delete(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(204);
    await request(s).patch(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).send({ title: 'Back again?' }).expect(409);
    // Still visible to its owner, with its status.
    const got = await request(s).get(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(200);
    expect(got.body.status).toBe('REMOVED');
  });

  it('DELETE is refused (409) once the media has a paid order', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    await insertPaidOrder(item.id);
    await request(app.getHttpServer()).delete(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(409);
    expect((await loadMedia(item.id)).status).toBe('PROCESSING');
  });
});

describe('Processing (worker service, mock verifier)', () => {
  it('processes a video: encrypted HLS preview, thumbnail, verification, incident, IN_REVIEW', { timeout: 90_000 }, async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.video);

    expect(await processing.process(item.id, { finalAttempt: false })).toBe('processed');

    const row = await loadMedia(item.id);
    expect(row).toMatchObject({
      status: 'IN_REVIEW',
      width: 320,
      height: 240,
      previewKey: storageKeys.hlsDir(item.id),
      thumbKey: storageKeys.thumbnail(item.id),
      processingError: null,
    });
    expect(row.durationSec).toBeCloseTo(3, 0);
    expect(row.hlsKeyHex).toMatch(/^[0-9a-f]{32}$/);
    expect(row.incidentId).toBeTruthy();

    // Preview files are where StreamService reads them.
    const storage = app.get(StorageService);
    const root = path.resolve(app.get(AppConfig).storageLocalDir);
    const playlist = await readFile(path.join(root, storageKeys.hlsPlaylist(item.id)), 'utf8');
    expect(playlist).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    expect(playlist).toMatch(/seg_000\.ts/);
    const hlsFiles = await readdir(path.join(root, storageKeys.hlsDir(item.id)));
    expect(hlsFiles).not.toContain('hls.key'); // the key is never stored next to the segments
    await expect(storage.getStream(storageKeys.thumbnail(item.id))).resolves.toBeTruthy();

    // The verifier got sampled frames plus the original, with the internal token.
    expect(verifier.requests).toHaveLength(1);
    expect(verifier.requests[0]).toMatchObject({
      mediaType: 'VIDEO',
      hasOriginal: true,
      token: app.get(AppConfig).internalToken,
    });
    expect(verifier.requests[0].frames).toBeGreaterThanOrEqual(1);
    expect(verifier.requests[0].frames).toBeLessThanOrEqual(8);

    const v = (await loadVerification(item.id))!;
    expect(v).toMatchObject({ aiScore: 0.12, aiModel: 'mock-detector', c2paStatus: 'absent', duplicateOfId: null });
    const codes = v.signals.map((s) => s.code);
    // GPS in the file (Delhi) is far from the claimed Kochi; FFmpeg's encoder tag means re-encoded.
    expect(codes).toEqual(expect.arrayContaining(['AI_SCORE_LOW', 'C2PA_ABSENT', 'LOCATION_MISMATCH', 'REENCODED']));
    expect(v.riskLevel).toBe('MEDIUM');
    expect(v.metadata).toMatchObject({
      file: { videoCodec: 'h264', audioCodec: 'aac', width: 320, height: 240 },
      capture: { latitude: 28.6139, longitude: 77.209, encoder: expect.stringMatching(/^Lavf/) },
      verifier: { available: true },
    });

    const [incident] = await db(app).select().from(incidents).where(eq(incidents.id, row.incidentId!));
    expect(incident).toMatchObject({ category: 'FIRE', title: 'Fire near Marine Drive, Kochi', mediaCount: 0 });

    // The owner sees the verification without the admin-only metadata.
    const own = await request(app.getHttpServer()).get(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(200);
    expect(own.body.status).toBe('IN_REVIEW');
    expect(own.body.thumbnailUrl).toMatch(/\/files\/thumb\//);
    expect(own.body.verification).toMatchObject({ riskLevel: 'MEDIUM', metadata: {} });

    // Running the job again (a BullMQ retry) changes nothing.
    expect(await processing.process(item.id, { finalAttempt: false })).toBe('skipped');
    expect(verifier.requests).toHaveLength(1);
  });

  it('feeds the admin review queue; after approval the preview streams', { timeout: 90_000 }, async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.video);
    await processing.process(item.id, { finalAttempt: false });

    const admin = await createAdmin(app);
    const s = app.getHttpServer();
    const queueRes = await request(s).get('/api/v1/admin/review-queue').set(auth(admin.accessToken)).expect(200);
    expect(queueRes.body.items).toHaveLength(1);
    expect(queueRes.body.items[0]).toMatchObject({ id: item.id, verification: { metadata: { file: { width: 320 } } } });

    await request(s).post(`/api/v1/admin/media/${item.id}/approve`).set(auth(admin.accessToken)).send({}).expect(200);
    const row = await loadMedia(item.id);
    const [incident] = await db(app).select().from(incidents).where(eq(incidents.id, row.incidentId!));
    expect(incident.mediaCount).toBe(1);

    const channel = await createUser(app, 'CHANNEL', { channelStatus: 'APPROVED' });
    const preview = await request(s).post(`/api/v1/market/media/${item.id}/preview`).set(auth(channel.accessToken)).expect(200);
    expect(preview.body.kind).toBe('hls');
    const base = new URL(preview.body.playlistUrl).pathname.replace(/index\.m3u8$/, '');
    const m3u8 = await request(s).get(`${base}index.m3u8`).expect(200);
    expect(m3u8.text).toContain('#EXTM3U');
    const key = await request(s).get(`${base}key.bin`).buffer(true).expect(200);
    expect(key.body.toString('hex')).toBe(row.hlsKeyHex);
    const seg = await request(s).get(`${base}seg_000.ts`).buffer(true).expect(200);
    expect(seg.body.length).toBeGreaterThan(1000);
  });

  it('processes a photo: watermarked preview JPEG and thumbnail', { timeout: 60_000 }, async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    await processing.process(item.id, { finalAttempt: false });

    const row = await loadMedia(item.id);
    expect(row).toMatchObject({
      status: 'IN_REVIEW',
      width: 640,
      height: 480,
      durationSec: null,
      hlsKeyHex: null,
      previewKey: storageKeys.previewImage(item.id),
      thumbKey: storageKeys.thumbnail(item.id),
    });
    const root = path.resolve(app.get(AppConfig).storageLocalDir);
    const preview = await readFile(path.join(root, storageKeys.previewImage(item.id)));
    expect(preview.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(verifier.requests[0]).toMatchObject({ mediaType: 'PHOTO', frames: 1, hasOriginal: true });

    const v = (await loadVerification(item.id))!;
    expect(v.signals.map((s) => s.code)).toEqual(expect.arrayContaining(['NO_METADATA']));
    expect(v.riskLevel).toBe('LOW');

    // The owner can open their own preview before approval.
    const s = app.getHttpServer();
    const p = await request(s).post(`/api/v1/market/media/${item.id}/preview`).set(auth(u.accessToken)).expect(200);
    expect(p.body.kind).toBe('image');
    await request(s).get(new URL(p.body.imageUrl).pathname).expect(200).expect('content-type', /image\/jpeg/);
  });

  it('keeps portrait videos portrait', { timeout: 60_000 }, async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.portrait);
    await processing.process(item.id, { finalAttempt: false });
    expect(await loadMedia(item.id)).toMatchObject({ status: 'IN_REVIEW', width: 240, height: 426, mimeType: 'video/quicktime' });
  });

  it('flags a near-duplicate of an earlier upload (same pHash, different bytes)', { timeout: 90_000 }, async () => {
    verifier.phash = 'a5f0c3e1b2d49687';
    const a = await createUser(app, 'UPLOADER');
    const b = await createUser(app, 'UPLOADER');
    const first = await uploadOk(a, fx.photo);
    await processing.process(first.id, { finalAttempt: false });
    const copy = await uploadOk(b, fx.png); // different checksum, "looks the same" to the mock
    await processing.process(copy.id, { finalAttempt: false });

    expect((await loadVerification(first.id))!.duplicateOfId).toBeNull();
    const v = (await loadVerification(copy.id))!;
    expect(v.duplicateOfId).toBe(first.id);
    expect(v.signals.map((s) => s.code)).toContain('DUPLICATE');
    expect(v.riskLevel).toBe('HIGH');
    expect(v.metadata).toMatchObject({ duplicate: { mediaId: first.id, distance: 0 } });
  });

  it('ignores uninformative pHashes (black frames) in the duplicate search', { timeout: 60_000 }, async () => {
    verifier.phash = '0000000000000000';
    const u = await createUser(app, 'UPLOADER');
    const first = await uploadOk(u, fx.photo);
    await processing.process(first.id, { finalAttempt: false });
    const second = await uploadOk(u, fx.png);
    await processing.process(second.id, { finalAttempt: false });
    expect((await loadVerification(second.id))!.duplicateOfId).toBeNull();
  });

  it('verifier down: retries first, then continues without it on the final attempt', { timeout: 90_000 }, async () => {
    verifier.mode = 'down';
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.video);

    await expect(processing.process(item.id, { finalAttempt: false })).rejects.toBeInstanceOf(VerifierUnavailableError);
    let row = await loadMedia(item.id);
    expect(row.status).toBe('PROCESSING');
    // The preview from the failed attempt is kept, so the retry does not encode again.
    expect(row.previewKey).toBe(storageKeys.hlsDir(item.id));
    const firstKey = row.hlsKeyHex;
    expect(await loadVerification(item.id)).toBeUndefined();

    await processing.process(item.id, { finalAttempt: true });
    row = await loadMedia(item.id);
    expect(row.status).toBe('IN_REVIEW');
    expect(row.hlsKeyHex).toBe(firstKey);
    const v = (await loadVerification(item.id))!;
    expect(v).toMatchObject({ aiScore: null, aiModel: null, c2paStatus: 'unsupported', phashes: [] });
    expect(v.signals.map((s) => s.code)).toContain('VERIFIER_UNAVAILABLE');
    expect(v.riskLevel).toBe('MEDIUM');
    expect(v.metadata).toMatchObject({ verifier: { available: false, error: expect.stringMatching(/HTTP 503/) } });
  });

  it('a 4xx from the verifier is not retried: processing continues at once', { timeout: 60_000 }, async () => {
    verifier.mode = 'unauthorized';
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    await processing.process(item.id, { finalAttempt: false });
    expect((await loadMedia(item.id)).status).toBe('IN_REVIEW');
    expect((await loadVerification(item.id))!.metadata).toMatchObject({ verifier: { available: false, error: expect.stringMatching(/HTTP 401/) } });
  });

  it('does not resurrect media removed while it was waiting', async () => {
    const u = await createUser(app, 'UPLOADER');
    const item = await uploadOk(u, fx.photo);
    await request(app.getHttpServer()).delete(`/api/v1/me/media/${item.id}`).set(auth(u.accessToken)).expect(204);
    expect(await processing.process(item.id, { finalAttempt: false })).toBe('skipped');
    expect((await loadMedia(item.id)).status).toBe('REMOVED');
  });

  it('clusters two nearby uploads of the same time into one incident', { timeout: 90_000 }, async () => {
    const a = await createUser(app, 'UPLOADER');
    const b = await createUser(app, 'UPLOADER');
    const one = await uploadOk(a, fx.photo);
    const two = await uploadOk(b, fx.video2, validFields({ latitude: String(KOCHI.lat + 0.002), capturedAt: hoursAgo(1.5) }));
    await processing.process(one.id, { finalAttempt: false });
    await processing.process(two.id, { finalAttempt: false });
    expect((await loadMedia(one.id)).incidentId).toBe((await loadMedia(two.id)).incidentId);
  });
});

// Last, because it starts the real BullMQ consumer, which then owns the queue.
describe('Worker end to end (real queue)', () => {
  it('processes queued uploads and marks a corrupt file FAILED without retrying', { timeout: 90_000 }, async () => {
    const u = await createUser(app, 'UPLOADER');
    const good = await uploadOk(u, fx.photo);
    const bad = await uploadOk(u, fx.corruptMp4);

    worker.get(MediaProcessor).start();

    const waitFor = async (id: string) => {
      for (let i = 0; i < 300; i++) {
        const row = await loadMedia(id);
        if (row.status !== 'PROCESSING') return row;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`media ${id} still PROCESSING`);
    };
    expect((await waitFor(good.id)).status).toBe('IN_REVIEW');
    const failed = await waitFor(bad.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.processingError).toMatch(/damaged|video track/);

    const job = await queue.getJob(bad.id);
    expect(job?.attemptsMade).toBe(1); // UnrecoverableError: no retries for a broken file
    expect(await job?.getState()).toBe('failed');

    // The uploader sees why, in their dashboard.
    const res = await request(app.getHttpServer()).get(`/api/v1/me/media/${bad.id}`).set(auth(u.accessToken)).expect(200);
    expect(res.body).toMatchObject({ status: 'FAILED', processingError: failed.processingError });
  });
});
