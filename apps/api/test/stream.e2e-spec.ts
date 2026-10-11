import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { SigningService } from '../src/common/signing.service.js';
import { DOWNLOAD_TTL_SEC, TOKEN, UrlService } from '../src/common/urls.service.js';
import { channelProfiles, media, orders } from '../src/db/schema.js';
import { JOB, MEDIA_QUEUE, PREVIEW_QUEUE } from '../src/processing/processing.constants.js';
import { STREAM_TOKEN, StreamService } from '../src/stream/stream.service.js';
import { auth, db, resetDb, startApp } from './helpers.js';
import {
  approvedChannel,
  cleanupStorage,
  createUser,
  FAKE_DELIVERY,
  FAKE_DELIVERY_SHA256,
  FAKE_JPEG,
  FAKE_SEGMENT,
  FAKE_VIEWER_JPEG,
  FAKE_VIEWER_SEGMENT,
  insertMedia,
  insertOrder,
  pathOf,
  writeViewerRendition,
} from './market.fixtures.js';

/** Supertest does not buffer binary bodies by default; this collects them into a Buffer. */
function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void) {
  const stream = res as unknown as NodeJS.ReadableStream; // at parse time, `res` is the raw HTTP response stream
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('Preview streaming and files (e2e)', () => {
  let app: NestExpressApplication;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await startApp();
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.get<Queue>(getQueueToken(PREVIEW_QUEUE)).obliterate({ force: true });
    await app.get<Queue>(getQueueToken(MEDIA_QUEUE)).obliterate({ force: true });
    await cleanupStorage(app);
    await app.close();
  });

  async function startPreview(token: string, mediaId: string, expected = 200) {
    return (await api().post(`/api/v1/market/media/${mediaId}/preview`).set(auth(token)).expect(expected)).body;
  }

  /** A newsroom's session, after the worker (simulated here) has rendered its marked copy. */
  async function channelPreview(channel: { accessToken: string; user: { id: string } }, row: typeof media.$inferSelect) {
    await writeViewerRendition(app, row, channel.user.id);
    return startPreview(channel.accessToken, row.id);
  }

  /** Absolute paths of the key and segment URIs written into a served playlist. */
  function urisOf(playlistPath: string, text: string) {
    const resolve = (rel: string) => new URL(rel, `http://x${playlistPath}`).pathname;
    const key = /URI="([^"]+)"/.exec(text)?.[1];
    const segments = text.split('\n').filter((l) => /seg_\d+\.ts$/.test(l));
    return { key: key ? resolve(key) : null, segments: segments.map(resolve) };
  }

  describe('POST /market/media/:id/preview', () => {
    it('gives an approved channel a signed HLS session with a watermark naming its organisation', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app, 'Kerala News 24');

      const body = await channelPreview(channel, video);
      expect(body.kind).toBe('hls');
      expect(body.playlistUrl).toMatch(/^http:\/\/localhost:4000\/api\/v1\/stream\/[\w-]+\.[\w-]+\/index\.m3u8$/);
      expect(body.watermarkText).toMatch(/^Preview · Kerala News 24 · [0-9A-F]{8} · \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST$/);
      // The playlist token is short-lived: the player loads it at once.
      const playlistToken = pathOf(body.playlistUrl).split('/')[4];
      const claims = app.get(SigningService).verify<{ exp: number; u: string }>(STREAM_TOKEN.playlist, playlistToken)!;
      expect(claims.u).toBe(channel.user.id);
      expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(120);
      const ttl = new Date(body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    });

    it('returns an image session for photos', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const photo = await insertMedia(app, uploader.user.id, { type: 'PHOTO' });
      const channel = await approvedChannel(app);

      const body = await channelPreview(channel, photo);
      expect(body).toMatchObject({ kind: 'image' });
      expect(body.imageUrl).toMatch(/\/image\.jpg$/);

      // The newsroom gets its own marked copy, not the generic preview.
      const res = await api().get(pathOf(body.imageUrl)).buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=600');
      expect(Buffer.compare(res.body, FAKE_VIEWER_JPEG)).toBe(0);
    });

    it('answers 202 "preparing" while a newsroom\'s marked copy is being rendered, and queues one render', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app);
      const streams = app.get(StreamService);
      streams.renderWaitMs = 300;
      try {
        const res = await api().post(`/api/v1/market/media/${video.id}/preview`).set(auth(channel.accessToken)).expect(202);
        expect(res.body).toEqual({ kind: 'preparing', retryAfterSec: 3 });
        expect(res.headers['retry-after']).toBe('3');
        await api().post(`/api/v1/market/media/${video.id}/preview`).set(auth(channel.accessToken)).expect(202);
      } finally {
        streams.renderWaitMs = 20_000;
      }
      const jobs = await app.get<Queue>(getQueueToken(PREVIEW_QUEUE)).getJobs(['waiting', 'prioritized', 'delayed']);
      const mine = jobs.filter((j) => j.data.mediaId === video.id);
      expect(mine.map((j) => j.data)).toEqual([{ mediaId: video.id, viewerId: channel.user.id }]);

      // Once the worker has written the rendition, the session starts.
      expect((await channelPreview(channel, video)).kind).toBe('hls');
    });

    it('closes previews for other newsrooms after an exclusive sale (410), but not for the buyer, owner or admins', async () => {
      const owner = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, owner.user.id);
      const buyer = await approvedChannel(app, 'Buyer TV');
      const other = await approvedChannel(app, 'Other TV');
      const admin = await createUser(app, 'ADMIN');
      const otherSession = await channelPreview(other, video);
      const otherPlaylist = await api().get(pathOf(otherSession.playlistUrl)).expect(200);
      const otherUris = urisOf(pathOf(otherSession.playlistUrl), otherPlaylist.text);

      await insertOrder(app, buyer.user.id, video.id, { licenseType: 'EXCLUSIVE' });
      await db(app).update(media).set({ exclusiveSold: true }).where(eq(media.id, video.id));

      const closed = await startPreview(other.accessToken, video.id, 410);
      expect(closed.message).toMatch(/licensed exclusively/);
      // Links handed out before the sale stop working too.
      await api().get(otherUris.segments[0]).expect(404);
      await api().get(otherUris.key!).expect(404);

      expect((await channelPreview(buyer, video)).kind).toBe('hls');
      expect((await startPreview(owner.accessToken, video.id)).kind).toBe('hls');
      expect((await startPreview(admin.accessToken, video.id)).kind).toBe('hls');
    });

    it('lets admins preview any status and owners preview their own media; uses the name when there is no organisation', async () => {
      const owner = await createUser(app, 'UPLOADER', { name: 'Anu' });
      const inReview = await insertMedia(app, owner.user.id, { status: 'IN_REVIEW' });
      const admin = await createUser(app, 'ADMIN', { name: 'Moderator' });

      expect((await startPreview(admin.accessToken, inReview.id)).watermarkText).toMatch(/^Preview · Moderator · /);
      expect((await startPreview(owner.accessToken, inReview.id)).kind).toBe('hls');
    });

    it('denies everyone else', async () => {
      const owner = await createUser(app, 'UPLOADER');
      const approved = await insertMedia(app, owner.user.id);
      const inReview = await insertMedia(app, owner.user.id, { status: 'IN_REVIEW' });
      const removed = await insertMedia(app, owner.user.id, { status: 'REMOVED' });
      const otherUploader = await createUser(app, 'UPLOADER');
      const pending = await createUser(app, 'CHANNEL');
      const rejected = await createUser(app, 'CHANNEL', { channelStatus: 'REJECTED' });
      const channel = await approvedChannel(app);

      await api().post(`/api/v1/market/media/${approved.id}/preview`).expect(401);
      await startPreview(otherUploader.accessToken, approved.id, 404); // not theirs: 404, not 403
      await startPreview(pending.accessToken, approved.id, 403);
      await startPreview(rejected.accessToken, approved.id, 403);
      await startPreview(channel.accessToken, inReview.id, 404); // not on sale yet
      await startPreview(owner.accessToken, removed.id, 404);
      await startPreview(channel.accessToken, '00000000-0000-4000-8000-000000000000', 404);
    });

    it('returns 409 while processing has not produced a preview', async () => {
      const owner = await createUser(app, 'UPLOADER');
      const processing = await insertMedia(app, owner.user.id, { status: 'PROCESSING' }, { withPreview: false });
      await startPreview(owner.accessToken, processing.id, 409);
    });
  });

  describe('HLS routes', () => {
    async function session() {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app);
      const body = await channelPreview(channel, video);
      const playlistPath = pathOf(body.playlistUrl);
      const playlist = await api().get(playlistPath).expect(200);
      const uris = urisOf(playlistPath, playlist.text);
      // `base` = the session (file) token directory: segments and the preview image.
      const base = uris.segments[0].replace(/seg_000\.ts$/, '');
      return { video, channel, playlistPath, playlist, keyPath: uris.key!, base, token: base.split('/')[4] };
    }

    it('serves the playlist, a segment and the 16-byte key with the right headers, each URI with its own token', async () => {
      const { video, channel, playlistPath, playlist, keyPath, base } = await session();

      expect(playlist.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
      expect(playlist.headers['cache-control']).toBe('private, no-store');
      expect(playlist.text).toMatch(/#EXT-X-KEY:METHOD=AES-128,URI="\.\.\/[\w-]+\.[\w-]+\/key\.bin"/);
      expect(playlist.text).toMatch(/^\.\.\/[\w-]+\.[\w-]+\/seg_000\.ts$/m);
      const signing = app.get(SigningService);
      const keyToken = keyPath.split('/')[4];
      expect(signing.verify<{ u: string }>(STREAM_TOKEN.key, keyToken)?.u).toBe(channel.user.id);
      expect(keyToken).not.toBe(base.split('/')[4]);

      // The newsroom's own rendition is served, not the generic preview.
      const segment = await api().get(`${base}seg_000.ts`).buffer(true).parse(binary).expect(200);
      expect(segment.headers['content-type']).toBe('video/mp2t');
      expect(segment.headers['cache-control']).toBe('private, max-age=600');
      expect(Buffer.compare(segment.body, FAKE_VIEWER_SEGMENT)).toBe(0);
      expect(Buffer.compare(segment.body, FAKE_SEGMENT)).not.toBe(0);

      // Each token opens only its own route: the segment token cannot fetch the key, nor the playlist.
      await api().get(`${base}key.bin`).expect(401);
      await api().get(`${base}index.m3u8`).expect(401);
      await api().get(playlistPath.replace('index.m3u8', 'seg_000.ts')).expect(401);

      const key = await api().get(keyPath).buffer(true).parse(binary).expect(200);
      expect(key.headers['content-type']).toBe('application/octet-stream');
      expect(key.headers['cache-control']).toBe('private, no-store');
      expect(key.body).toHaveLength(16);
      expect(key.body.toString('hex')).toBe(video.hlsKeyHex);
    });

    it('rejects bad segment names, including path traversal', async () => {
      const { base } = await session();
      for (const name of ['seg_1.ts', 'seg_000.mp4', 'index.m3u9', 'seg_000000.ts', '..%2F..%2Fsecret.ts', '%2E%2E']) {
        await api().get(`${base}${name}`).expect(404);
      }
      // Express normalises "../" in paths, so these never reach a stream route with a segment.
      await api().get(`${base}../x`).expect(404);
      await api().get(`${base}..%2Fx`).expect(404);
      await api().get(`${base}seg_002.ts`).expect(404); // valid name, but no such file
    });

    it('rejects tampered, expired and wrong-purpose tokens', async () => {
      const { video, channel, playlistPath, token } = await session();
      const signing = app.get(SigningService);

      // Tampered: swap the payload for another media id but keep the signature.
      const [, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ m: video.id, u: channel.user.id, p: STREAM_TOKEN.playlist, exp: 9999999999 }),
      ).toString('base64url');
      await api().get(`/api/v1/stream/${forged}.${signature}/index.m3u8`).expect(401);
      await api().get(`/api/v1/stream/garbage/index.m3u8`).expect(401);

      // Expired.
      const expired = signing.sign(STREAM_TOKEN.playlist, { m: video.id, u: channel.user.id }, -1);
      await api().get(`/api/v1/stream/${expired}/index.m3u8`).expect(401);
      const expiredKey = signing.sign(STREAM_TOKEN.key, { m: video.id, u: channel.user.id }, -1);
      await api().get(`/api/v1/stream/${expiredKey}/key.bin`).expect(401);

      // Right signature, wrong purpose (a thumbnail token cannot open the stream).
      const thumb = signing.sign(TOKEN.thumb, { m: video.id, u: channel.user.id }, 600);
      await api().get(`/api/v1/stream/${thumb}/key.bin`).expect(401);

      // Garbage ids inside a validly signed token are rejected without touching the database.
      const badIds = signing.sign(STREAM_TOKEN.playlist, { m: "x' OR 1=1", u: channel.user.id }, 600);
      await api().get(`/api/v1/stream/${badIds}/index.m3u8`).expect(401);

      // A token without a viewer is refused: every token names who is watching.
      const noViewer = signing.sign(STREAM_TOKEN.playlist, { m: video.id }, 600);
      await api().get(`/api/v1/stream/${noViewer}/index.m3u8`).expect(401);

      // The original still works.
      await api().get(playlistPath).expect(200);
    });

    it('stops working as soon as the media is removed or the channel loses approval', async () => {
      const { video, channel, playlistPath, keyPath } = await session();
      await db(app).update(media).set({ status: 'REMOVED' }).where(eq(media.id, video.id));
      await api().get(playlistPath).expect(404);
      await api().get(keyPath).expect(404);

      await db(app).update(media).set({ status: 'APPROVED' }).where(eq(media.id, video.id));
      await api().get(keyPath).expect(200);
      await db(app)
        .update(channelProfiles)
        .set({ status: 'REJECTED' })
        .where(eq(channelProfiles.userId, channel.user.id));
      await api().get(keyPath).expect(404);
    });

    it('does not let a video token open a photo route', async () => {
      const { base } = await session();
      await api().get(`${base}image.jpg`).expect(404);
    });
  });

  describe('files', () => {
    it('serves thumbnails with a thumb token only', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const url = app.get(UrlService).thumbnailUrl(video)!;

      const res = await api().get(pathOf(url)).buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=3600');
      expect(Buffer.compare(res.body, FAKE_JPEG)).toBe(0);

      const streamToken = app.get(SigningService).sign(TOKEN.stream, { m: video.id }, 600);
      await api().get(`/api/v1/files/thumb/${streamToken}`).expect(401);

      await db(app).update(media).set({ status: 'REMOVED' }).where(eq(media.id, video.id));
      await api().get(pathOf(url)).expect(404);
    });

    it('serves the metadata-free delivery copy (never the original) for PAID orders only, with its checksum', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id, { title: 'Fire at "Marine Drive" / Kochi!' });
      const channel = await approvedChannel(app);
      const urls = app.get(UrlService);

      const paid = await insertOrder(app, channel.user.id, video.id);
      const res = await api()
        .get(pathOf(urls.downloadUrl(paid.id, paid.buyerId).url))
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-disposition']).toBe('attachment; filename="Fire-at-Marine-Drive-Kochi.mp4"');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-sha256']).toBe(FAKE_DELIVERY_SHA256);
      expect(res.headers['repr-digest']).toBe(`sha-256=:${Buffer.from(FAKE_DELIVERY_SHA256, 'hex').toString('base64')}:`);
      expect(Buffer.compare(res.body, FAKE_DELIVERY)).toBe(0);

      const created = await insertOrder(app, channel.user.id, video.id, { status: 'CREATED', paidAt: null });
      const failed = await insertOrder(app, channel.user.id, video.id, { status: 'FAILED', paidAt: null });
      await api()
        .get(pathOf(urls.downloadUrl(created.id, created.buyerId).url))
        .expect(404);
      await api()
        .get(pathOf(urls.downloadUrl(failed.id, failed.buyerId).url))
        .expect(404);

      // Tokens of another purpose, or expired, are refused.
      const signing = app.get(SigningService);
      await api()
        .get(`/api/v1/files/download/${signing.sign(TOKEN.thumb, { o: paid.id }, 600)}`)
        .expect(401);
      await api()
        .get(`/api/v1/files/download/${signing.sign(TOKEN.download, { o: paid.id }, -1)}`)
        .expect(401);
    });

    it('needs the buyer\'s session to get a link, and each link works once (review M3)', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const buyer = await approvedChannel(app, 'Buyer TV');
      const other = await approvedChannel(app, 'Other TV');
      const paid = await insertOrder(app, buyer.user.id, video.id);

      // No session, or someone else's session: no link.
      await api().get(`/api/v1/orders/${paid.id}/download`).expect(401);
      await api().get(`/api/v1/orders/${paid.id}/download`).set(auth(other.accessToken)).expect(404);

      const link = (await api().get(`/api/v1/orders/${paid.id}/download`).set(auth(buyer.accessToken)).expect(200)).body;
      await api().head(pathOf(link.url)).expect(405); // a link checker does not use it up
      await api().get(pathOf(link.url)).buffer(true).parse(binary).expect(200);
      // Forwarded or replayed: refused.
      const reuse = await api().get(pathOf(link.url)).expect(410);
      expect(reuse.body.message).toMatch(/already been used/);

      // A link that names another buyer is refused.
      const signing = app.get(SigningService);
      const otherBuyer = signing.sign(TOKEN.download, { o: paid.id, u: other.user.id }, DOWNLOAD_TTL_SEC);
      await api().get(`/api/v1/files/download/${otherBuyer}`).expect(404);

      // A link must be redeemed within 2 minutes of being issued, whatever its expiry says.
      const stale = signing.sign(TOKEN.download, { o: paid.id }, DOWNLOAD_TTL_SEC - 3 * 60);
      await api().get(`/api/v1/files/download/${stale}`).expect(401);
    });

    it('counts completed downloads, not links handed out', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app);
      const paid = await insertOrder(app, channel.user.id, video.id);
      const urls = app.get(UrlService);
      const count = async () =>
        (await db(app).select({ n: orders.downloadCount }).from(orders).where(eq(orders.id, paid.id)))[0].n;

      urls.downloadUrl(paid.id, paid.buyerId); // minted but never used
      // Two different links (the same order and second would sign the same token).
      const signing = app.get(SigningService);
      for (const ttl of [DOWNLOAD_TTL_SEC, DOWNLOAD_TTL_SEC - 1]) {
        const token = signing.sign(TOKEN.download, { o: paid.id }, ttl);
        await api().get(`/api/v1/files/download/${token}`).buffer(true).parse(binary).expect(200);
      }
      await expect.poll(count).toBe(2);
    });

    it('answers 409 "being prepared" and queues a job when the delivery copy does not exist yet', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id, {}, { withDelivery: false });
      const channel = await approvedChannel(app);
      const paid = await insertOrder(app, channel.user.id, video.id);
      const res = await api().get(pathOf(app.get(UrlService).downloadUrl(paid.id, paid.buyerId).url)).expect(409);
      expect(res.body.message).toMatch(/being prepared/);
      const job = await app.get<Queue>(getQueueToken(MEDIA_QUEUE)).getJob(`delivery-${video.id}`);
      expect(job?.name).toBe(JOB.prepareDelivery);
    });
  });
});
