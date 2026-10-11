import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { incidents, media } from '../src/db/schema.js';
import { auth, db, resetDb, startApp } from './helpers.js';
import {
  ALUVA,
  approvedChannel,
  cleanupStorage,
  CHENNAI,
  createUser,
  insertIncident,
  insertMedia,
  insertOrder,
  KOCHI,
} from './market.fixtures.js';

describe('Marketplace (e2e)', () => {
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

  /** Lists media as `token` with the given query and returns the response body. */
  async function list(token: string, query: Record<string, string | number> = {}) {
    const res = await api().get('/api/v1/market/media').query(query).set(auth(token)).expect(200);
    return res.body as { items: Array<Record<string, any>>; total: number; page: number; pageSize: number };
  }

  describe('access', () => {
    it('requires login, the CHANNEL or ADMIN role, and an approved organisation', async () => {
      await api().get('/api/v1/market/media').expect(401);

      const uploader = await createUser(app, 'UPLOADER');
      await api().get('/api/v1/market/media').set(auth(uploader.accessToken)).expect(403);

      const pending = await createUser(app, 'CHANNEL');
      const res = await api().get('/api/v1/market/incidents').set(auth(pending.accessToken)).expect(403);
      expect(res.body.message).toMatch(/not been approved/);

      const channel = await approvedChannel(app);
      await api().get('/api/v1/market/media').set(auth(channel.accessToken)).expect(200);

      const admin = await createUser(app, 'ADMIN');
      await api().get('/api/v1/market/media').set(auth(admin.accessToken)).expect(200);
    });
  });

  describe('GET /market/media', () => {
    it('lists only APPROVED media and never exposes the uploader', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const approved = await insertMedia(app, uploader.user.id);
      for (const status of ['PROCESSING', 'IN_REVIEW', 'REJECTED', 'FAILED', 'REMOVED'] as const) {
        await insertMedia(app, uploader.user.id, { status });
      }
      const channel = await approvedChannel(app);

      const body = await list(channel.accessToken);
      expect(body.total).toBe(1);
      expect(body.items.map((m) => m.id)).toEqual([approved.id]);

      const item = body.items[0];
      expect(item.thumbnailUrl).toMatch(/\/api\/v1\/files\/thumb\//);
      expect(item.verification.riskLevel).toBe('LOW');
      expect(item.verification.metadata).toEqual({}); // full metadata is admin-only
      expect(item).not.toHaveProperty('distanceKm');

      // The uploader's identity must not appear anywhere in the response.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(uploader.user.id);
      expect(raw).not.toContain(uploader.user.email);
      for (const key of ['uploaderId', 'uploader', 'originalKey', 'originalName', 'checksum', 'hlsKeyHex', 'status']) {
        expect(item).not.toHaveProperty(key);
      }
    });

    it('shows full verification metadata to admins only', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      await insertMedia(app, uploader.user.id);
      const admin = await createUser(app, 'ADMIN');
      const body = await list(admin.accessToken);
      expect(body.items[0].verification.metadata).toMatchObject({ device: 'Pixel 8' });
    });

    it('filters by category, type and capture time', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const fire = await insertMedia(app, uploader.user.id, { category: 'FIRE' });
      const flood = await insertMedia(app, uploader.user.id, { category: 'FLOOD', type: 'PHOTO' });
      const old = await insertMedia(app, uploader.user.id, {
        category: 'FIRE',
        capturedAt: new Date(Date.now() - 48 * 3600 * 1000),
      });
      const channel = await approvedChannel(app);

      expect((await list(channel.accessToken, { category: 'FLOOD' })).items.map((m) => m.id)).toEqual([flood.id]);
      expect((await list(channel.accessToken, { type: 'PHOTO' })).items.map((m) => m.id)).toEqual([flood.id]);

      const recentFire = await list(channel.accessToken, { category: 'FIRE', sinceHours: 24 });
      expect(recentFire.items.map((m) => m.id)).toEqual([fire.id]);
      const allFire = await list(channel.accessToken, { category: 'FIRE', sinceHours: 72 });
      expect(allFire.items.map((m) => m.id).sort()).toEqual([fire.id, old.id].sort());
    });

    it('filters by radius and sorts by distance', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const kochi = await insertMedia(app, uploader.user.id, { latitude: KOCHI.lat, longitude: KOCHI.lng });
      const aluva = await insertMedia(app, uploader.user.id, { latitude: ALUVA.lat, longitude: ALUVA.lng });
      await insertMedia(app, uploader.user.id, { latitude: CHENNAI.lat, longitude: CHENNAI.lng });
      const channel = await approvedChannel(app);

      // Default radius is 50 km: Chennai (about 550 km away) is excluded.
      const near = await list(channel.accessToken, { lat: ALUVA.lat, lng: ALUVA.lng, sort: 'nearest' });
      expect(near.total).toBe(2);
      expect(near.items.map((m) => m.id)).toEqual([aluva.id, kochi.id]);
      expect(near.items[0].distanceKm).toBe(0);
      expect(near.items[1].distanceKm).toBeGreaterThan(18);
      expect(near.items[1].distanceKm).toBeLessThan(25);

      // A 10 km radius around Kochi leaves only Kochi.
      const tight = await list(channel.accessToken, { lat: KOCHI.lat, lng: KOCHI.lng, radiusKm: 10 });
      expect(tight.items.map((m) => m.id)).toEqual([kochi.id]);

      // The maximum radius reaches Chennai too.
      const wide = await list(channel.accessToken, { lat: KOCHI.lat, lng: KOCHI.lng, radiusKm: 500 });
      expect(wide.total).toBe(2);
      const widest = await list(channel.accessToken, { lat: 11.5, lng: 78.2, radiusKm: 500 });
      expect(widest.total).toBe(3);
    });

    it('validates query parameters', async () => {
      const channel = await approvedChannel(app);
      const get = (query: Record<string, string | number>) =>
        api().get('/api/v1/market/media').query(query).set(auth(channel.accessToken));

      await get({ sort: 'nearest' }).expect(400); // nearest needs a point
      await get({ lat: 10 }).expect(400); // lat without lng
      await get({ radiusKm: 10 }).expect(400); // radius without a point
      await get({ lat: 10, lng: 76, radiusKm: 501 }).expect(400);
      await get({ lat: 91, lng: 76 }).expect(400);
      await get({ sinceHours: 0 }).expect(400);
      await get({ category: 'NOPE' }).expect(400);
      await get({ pageSize: 101 }).expect(400);
      await get({ unknown: 'x' }).expect(400); // forbidNonWhitelisted
    });

    it('searches title, description and location, treating % and _ literally', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const bridge = await insertMedia(app, uploader.user.id, {
        title: 'Bridge collapse',
        description: null,
        locationName: null,
      });
      const desc = await insertMedia(app, uploader.user.id, {
        title: 'Road scene',
        description: 'A BRIDGE in the background',
      });
      const place = await insertMedia(app, uploader.user.id, {
        title: 'Crowd',
        description: null,
        locationName: 'Vyttila Hub',
      });
      const percent = await insertMedia(app, uploader.user.id, { title: '100% flooded street', description: null });
      const channel = await approvedChannel(app);

      const bridges = await list(channel.accessToken, { q: 'bridge' });
      expect(bridges.items.map((m) => m.id).sort()).toEqual([bridge.id, desc.id].sort());
      expect((await list(channel.accessToken, { q: 'vyttila' })).items.map((m) => m.id)).toEqual([place.id]);
      expect((await list(channel.accessToken, { q: '100%' })).items.map((m) => m.id)).toEqual([percent.id]);
      // Unescaped, "%" would match every row.
      expect((await list(channel.accessToken, { q: '%' })).items.map((m) => m.id)).toEqual([percent.id]);
      expect((await list(channel.accessToken, { q: '_' })).total).toBe(0);
    });

    it('sorts by incident trend score, then recency', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const hot = await insertIncident(app, { trendScore: 9.5 });
      const cold = await insertIncident(app, { trendScore: 0.5 });
      const now = Date.now();
      const inHot = await insertMedia(app, uploader.user.id, {
        incidentId: hot.id,
        reviewedAt: new Date(now - 3600_000),
      });
      const inCold = await insertMedia(app, uploader.user.id, { incidentId: cold.id, reviewedAt: new Date(now) });
      const loose = await insertMedia(app, uploader.user.id, { incidentId: null, reviewedAt: new Date(now - 60_000) });
      const channel = await approvedChannel(app);

      const trending = await list(channel.accessToken, { sort: 'trending' });
      expect(trending.items.map((m) => m.id)).toEqual([inHot.id, inCold.id, loose.id]);

      const recent = await list(channel.accessToken, { sort: 'recent' });
      expect(recent.items.map((m) => m.id)).toEqual([inCold.id, loose.id, inHot.id]);
    });

    it('paginates', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      for (let i = 0; i < 5; i++) await insertMedia(app, uploader.user.id);
      const channel = await approvedChannel(app);

      const page1 = await list(channel.accessToken, { page: 1, pageSize: 2 });
      const page3 = await list(channel.accessToken, { page: 3, pageSize: 2 });
      expect(page1).toMatchObject({ total: 5, page: 1, pageSize: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page3.items).toHaveLength(1);
      expect(page3.items[0].id).not.toBe(page1.items[0].id);
    });

    it('reports purchases and licence availability per caller', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const free = await insertMedia(app, uploader.user.id, { title: 'Unsold clip' });
      const sold = await insertMedia(app, uploader.user.id, { title: 'Sold clip' });
      const exclusive = await insertMedia(app, uploader.user.id, { title: 'Exclusive clip', exclusiveSold: true });
      const buyer = await approvedChannel(app, 'Buyer TV');
      const other = await approvedChannel(app, 'Other TV');
      const order = await insertOrder(app, buyer.user.id, sold.id);
      await insertOrder(app, other.user.id, exclusive.id, { licenseType: 'EXCLUSIVE' });
      // A CREATED (unpaid) order changes nothing.
      await insertOrder(app, buyer.user.id, free.id, { status: 'CREATED', paidAt: null });

      const byId = (items: Array<Record<string, any>>) => new Map(items.map((m) => [m.id, m]));
      const asBuyer = byId((await list(buyer.accessToken)).items);
      expect(asBuyer.get(free.id)).toMatchObject({
        purchased: null,
        availability: { nonExclusive: true, exclusive: true },
      });
      expect(asBuyer.get(sold.id)).toMatchObject({
        purchased: { orderId: order.id, licenseType: 'NON_EXCLUSIVE' },
        availability: { nonExclusive: false, exclusive: false },
      });
      expect(asBuyer.get(exclusive.id)).toMatchObject({
        purchased: null,
        availability: { nonExclusive: false, exclusive: false },
      });

      // Another channel can still buy a non-exclusive licence of `sold`, but not the exclusive one.
      const asOther = byId((await list(other.accessToken)).items);
      expect(asOther.get(sold.id)).toMatchObject({
        purchased: null,
        availability: { nonExclusive: true, exclusive: false },
      });
      expect(asOther.get(exclusive.id)).toMatchObject({ purchased: { licenseType: 'EXCLUSIVE' } });
    });
  });

  describe('GET /market/media/:id', () => {
    it('returns approved media and counts the view on the media and its incident', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const incident = await insertIncident(app);
      const item = await insertMedia(app, uploader.user.id, { incidentId: incident.id });
      const channel = await approvedChannel(app);

      const res = await api().get(`/api/v1/market/media/${item.id}`).set(auth(channel.accessToken)).expect(200);
      expect(res.body).toMatchObject({ id: item.id, incidentId: incident.id, purchased: null });
      expect(JSON.stringify(res.body)).not.toContain(uploader.user.id);

      // Concurrent views must all be counted (atomic increment).
      await Promise.all(
        [1, 2, 3, 4].map(() => api().get(`/api/v1/market/media/${item.id}`).set(auth(channel.accessToken)).expect(200)),
      );
      const [m] = await db(app).select().from(media).where(eq(media.id, item.id));
      const [i] = await db(app).select().from(incidents).where(eq(incidents.id, incident.id));
      expect(m.viewCount).toBe(5);
      expect(i.viewCount).toBe(5);
    });

    it('hides non-approved media from channels (404) but shows it to admins', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const inReview = await insertMedia(app, uploader.user.id, { status: 'IN_REVIEW' });
      const channel = await approvedChannel(app);
      const admin = await createUser(app, 'ADMIN');

      await api().get(`/api/v1/market/media/${inReview.id}`).set(auth(channel.accessToken)).expect(404);
      const res = await api().get(`/api/v1/market/media/${inReview.id}`).set(auth(admin.accessToken)).expect(200);
      expect(res.body.availability).toEqual({ nonExclusive: false, exclusive: false });

      // Neither request counted as a market view.
      const [m] = await db(app).select().from(media).where(eq(media.id, inReview.id));
      expect(m.viewCount).toBe(0);

      await api().get('/api/v1/market/media/not-a-uuid').set(auth(channel.accessToken)).expect(400);
      await api()
        .get('/api/v1/market/media/00000000-0000-4000-8000-000000000000')
        .set(auth(channel.accessToken))
        .expect(404);
    });
  });

  describe('incidents', () => {
    it('lists incidents that have approved media, with filters and both sorts', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const now = Date.now();
      const hot = await insertIncident(app, { title: 'Hot', trendScore: 8, lastSeenAt: new Date(now - 3 * 3600_000) });
      const fresh = await insertIncident(app, { title: 'Fresh', trendScore: 2, lastSeenAt: new Date(now) });
      const flood = await insertIncident(app, {
        title: 'Flood',
        category: 'FLOOD',
        trendScore: 1,
        lastSeenAt: new Date(now - 5 * 3600_000),
        latitude: CHENNAI.lat,
        longitude: CHENNAI.lng,
      });
      await insertIncident(app, { title: 'Empty', mediaCount: 0 });
      await insertIncident(app, { title: 'Old', lastSeenAt: new Date(now - 100 * 3600_000) });

      // Thumbnail = newest approved media of the incident.
      await insertMedia(app, uploader.user.id, { incidentId: hot.id, reviewedAt: new Date(now - 7200_000) });
      const newest = await insertMedia(app, uploader.user.id, { incidentId: hot.id, reviewedAt: new Date(now) });
      const channel = await approvedChannel(app);
      const get = async (query: Record<string, string | number> = {}) =>
        (await api().get('/api/v1/market/incidents').query(query).set(auth(channel.accessToken)).expect(200)).body;

      const trending = await get();
      expect(trending.items.map((i: { title: string }) => i.title)).toEqual(['Hot', 'Fresh', 'Flood']);
      expect(trending.total).toBe(3);
      expect(trending.items[0]).toMatchObject({ id: hot.id, mediaCount: 1, trendScore: 8 });
      expect(trending.items[0].thumbnailUrl).toContain('/files/thumb/');
      expect(trending.items[1].thumbnailUrl).toBeNull();

      const recent = await get({ sort: 'recent' });
      expect(recent.items[0].id).toBe(fresh.id);

      expect((await get({ category: 'FLOOD' })).items.map((i: { id: string }) => i.id)).toEqual([flood.id]);
      expect((await get({ lat: KOCHI.lat, lng: KOCHI.lng, radiusKm: 20 })).total).toBe(2);
      expect((await get({ sinceHours: 200 })).total).toBe(4);

      // The thumbnail token is for the newest media.
      const token = trending.items[0].thumbnailUrl.split('/files/thumb/')[1];
      const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
      expect(payload.m).toBe(newest.id);
    });

    it('returns incident detail with its approved media only', async () => {
      const uploader = await createUser(app, 'UPLOADER');
      const incident = await insertIncident(app, { mediaCount: 2, uploaderCount: 1 });
      const a = await insertMedia(app, uploader.user.id, { incidentId: incident.id });
      const b = await insertMedia(app, uploader.user.id, { incidentId: incident.id, type: 'PHOTO' });
      await insertMedia(app, uploader.user.id, { incidentId: incident.id, status: 'REJECTED' });
      const empty = await insertIncident(app, { mediaCount: 0 });
      const channel = await approvedChannel(app);

      const res = await api().get(`/api/v1/market/incidents/${incident.id}`).set(auth(channel.accessToken)).expect(200);
      expect(res.body).toMatchObject({ id: incident.id, mediaCount: 2, uploaderCount: 1 });
      expect(res.body.media.map((m: { id: string }) => m.id).sort()).toEqual([a.id, b.id].sort());
      expect(res.body.thumbnailUrl).toContain('/files/thumb/');
      expect(JSON.stringify(res.body)).not.toContain(uploader.user.id);

      await api().get(`/api/v1/market/incidents/${empty.id}`).set(auth(channel.accessToken)).expect(404);
    });
  });
});
