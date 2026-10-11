import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { SigningService } from '../src/common/signing.service.js';
import { TOKEN, UrlService } from '../src/common/urls.service.js';
import { channelProfiles, media } from '../src/db/schema.js';
import { auth, db, resetDb, startApp } from './helpers.js';
import {
  approvedChannel,
  cleanupStorage,
  createUser,
  FAKE_JPEG,
  FAKE_ORIGINAL,
  FAKE_SEGMENT,
  insertMedia,
  insertOrder,
  pathOf,
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
    await cleanupStorage(app);
    await app.close();
  });

  async function startPreview(token: string, mediaId: string, expected = 200) {
    return (await api().post(`/api/v1/market/media/${mediaId}/preview`).set(auth(token)).expect(expected)).body;
  }

  describe('POST /market/media/:id/preview', () => {
    it('gives an approved channel a signed HLS session with a watermark naming its organisation', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app, 'Kerala News 24');

      const body = await startPreview(channel.accessToken, video.id);
      expect(body.kind).toBe('hls');
      expect(body.playlistUrl).toMatch(/^http:\/\/localhost:4000\/api\/v1\/stream\/[\w-]+\.[\w-]+\/index\.m3u8$/);
      expect(body.watermarkText).toMatch(/^Preview · Kerala News 24 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST$/);
      const ttl = new Date(body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(9 * 60_000);
      expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    });

    it('returns an image session for photos', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const photo = await insertMedia(app, uploader.user.id, { type: 'PHOTO' });
      const channel = await approvedChannel(app);

      const body = await startPreview(channel.accessToken, photo.id);
      expect(body).toMatchObject({ kind: 'image' });
      expect(body.imageUrl).toMatch(/\/image\.jpg$/);

      const res = await api().get(pathOf(body.imageUrl)).buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=600');
      expect(Buffer.compare(res.body, FAKE_JPEG)).toBe(0);
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
      const body = await startPreview(channel.accessToken, video.id);
      const base = pathOf(body.playlistUrl).replace(/index\.m3u8$/, '');
      return { video, channel, base, token: base.split('/')[4] };
    }

    it('serves the playlist, a segment and the 16-byte key with the right headers', async () => {
      const { video, base } = await session();

      const playlist = await api().get(`${base}index.m3u8`).expect(200);
      expect(playlist.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
      expect(playlist.headers['cache-control']).toBe('private, no-store');
      expect(playlist.text).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
      expect(playlist.text).toContain('seg_000.ts');

      const segment = await api().get(`${base}seg_000.ts`).buffer(true).parse(binary).expect(200);
      expect(segment.headers['content-type']).toBe('video/mp2t');
      expect(segment.headers['cache-control']).toBe('private, max-age=600');
      expect(Buffer.compare(segment.body, FAKE_SEGMENT)).toBe(0);

      const key = await api().get(`${base}key.bin`).buffer(true).parse(binary).expect(200);
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
      await api().get(`${base}seg_001.ts`).expect(404); // valid name, but no such file
    });

    it('rejects tampered, expired and wrong-purpose tokens', async () => {
      const { video, channel, base, token } = await session();
      const signing = app.get(SigningService);

      // Tampered: swap the payload for another media id but keep the signature.
      const [, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ m: video.id, u: channel.user.id, p: 'stream', exp: 9999999999 }),
      ).toString('base64url');
      await api().get(`/api/v1/stream/${forged}.${signature}/index.m3u8`).expect(401);
      await api().get(`/api/v1/stream/garbage/index.m3u8`).expect(401);

      // Expired.
      const expired = signing.sign(TOKEN.stream, { m: video.id, u: channel.user.id }, -1);
      await api().get(`/api/v1/stream/${expired}/index.m3u8`).expect(401);

      // Right signature, wrong purpose (a thumbnail token cannot open the stream).
      const thumb = signing.sign(TOKEN.thumb, { m: video.id, u: channel.user.id }, 600);
      await api().get(`/api/v1/stream/${thumb}/key.bin`).expect(401);

      // Garbage ids inside a validly signed token are rejected without touching the database.
      const badIds = signing.sign(TOKEN.stream, { m: "x' OR 1=1", u: channel.user.id }, 600);
      await api().get(`/api/v1/stream/${badIds}/index.m3u8`).expect(401);

      // The original still works.
      await api().get(`${base}index.m3u8`).expect(200);
    });

    it('stops working as soon as the media is removed or the channel loses approval', async () => {
      const { video, channel, base } = await session();
      await db(app).update(media).set({ status: 'REMOVED' }).where(eq(media.id, video.id));
      await api().get(`${base}index.m3u8`).expect(404);
      await api().get(`${base}key.bin`).expect(404);

      await db(app).update(media).set({ status: 'APPROVED' }).where(eq(media.id, video.id));
      await api().get(`${base}key.bin`).expect(200);
      await db(app)
        .update(channelProfiles)
        .set({ status: 'REJECTED' })
        .where(eq(channelProfiles.userId, channel.user.id));
      await api().get(`${base}key.bin`).expect(404);
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

    it('serves the original as an attachment for PAID orders only', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const video = await insertMedia(app, uploader.user.id, { title: 'Fire at "Marine Drive" / Kochi!' });
      const channel = await approvedChannel(app);
      const urls = app.get(UrlService);

      const paid = await insertOrder(app, channel.user.id, video.id);
      const res = await api()
        .get(pathOf(urls.downloadUrl(paid.id).url))
        .buffer(true)
        .parse(binary)
        .expect(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-disposition']).toBe('attachment; filename="Fire-at-Marine-Drive-Kochi.mp4"');
      expect(Buffer.compare(res.body, FAKE_ORIGINAL)).toBe(0);

      const created = await insertOrder(app, channel.user.id, video.id, { status: 'CREATED', paidAt: null });
      const failed = await insertOrder(app, channel.user.id, video.id, { status: 'FAILED', paidAt: null });
      await api()
        .get(pathOf(urls.downloadUrl(created.id).url))
        .expect(404);
      await api()
        .get(pathOf(urls.downloadUrl(failed.id).url))
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
  });
});
