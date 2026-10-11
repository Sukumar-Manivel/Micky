import type { NestExpressApplication } from '@nestjs/platform-express';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import {
  channelProfiles,
  ledgerEntries,
  media,
  orders,
} from '../src/db/schema.js';
import {
  auth,
  createAdmin,
  db,
  registerUser,
  resetDb,
  startApp,
} from './helpers.js';
import {
  buy,
  clearRateLimits,
  createApprovedChannel,
  createUploader,
  insertMedia,
  type MediaRow,
} from './orders.fixtures.js';

// Runs with PAYMENTS_PROVIDER=mock (vitest.config.e2e.ts). The Razorpay paths
// (verify + webhook) are covered in orders-razorpay.e2e-spec.ts.
describe('Orders (e2e, mock provider)', () => {
  let app: NestExpressApplication;
  let server: ReturnType<NestExpressApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await startApp();
    server = app.getHttpServer();
  });
  beforeEach(async () => {
    await resetDb(app);
    clearRateLimits(app);
  });
  afterAll(async () => {
    await app.close();
  });

  async function setup() {
    const uploader = await createUploader(app);
    const channel = await createApprovedChannel(app);
    const item = await insertMedia(app, uploader.user.id);
    return { uploader, channel, item };
  }

  const ledgerFor = (orderId: string) =>
    db(app)
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));

  describe('POST /orders', () => {
    it('creates a checkout with the right amount and a 30% platform fee split', async () => {
      const { channel, item } = await setup();
      const res = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);

      expect(res.body).toEqual({
        orderId: expect.any(String),
        amount: 1_500_00,
        currency: 'INR',
        provider: 'mock',
        description: 'Non-exclusive licence: Fire near Gandhipuram',
      });
      expect(res.body).not.toHaveProperty('razorpay');

      const [row] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, res.body.orderId));
      expect(row).toMatchObject({
        status: 'CREATED',
        amount: 1_500_00,
        platformFee: 450_00,
        uploaderShare: 1_050_00,
        provider: 'mock',
        buyerId: channel.user.id,
      });
      expect(row.providerOrderId).toMatch(/^mock_order_/);
    });

    it('reuses a recent unpaid checkout instead of creating duplicates', async () => {
      const { channel, item } = await setup();
      const body = { mediaId: item.id, licenseType: 'EXCLUSIVE' };
      const a = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send(body)
        .expect(201);
      const b = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send(body)
        .expect(201);
      expect(b.body.orderId).toBe(a.body.orderId);
      expect(a.body.amount).toBe(5_000_00);

      // A different licence type is a different checkout.
      const c = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ ...body, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      expect(c.body.orderId).not.toBe(a.body.orderId);
    });

    it('does not reuse a checkout older than 30 minutes', async () => {
      const { channel, item } = await setup();
      const body = { mediaId: item.id, licenseType: 'NON_EXCLUSIVE' };
      const a = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send(body)
        .expect(201);
      await db(app)
        .update(orders)
        .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
        .where(eq(orders.id, a.body.orderId));
      const b = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send(body)
        .expect(201);
      expect(b.body.orderId).not.toBe(a.body.orderId);
    });

    it('only lets approved news channels order', async () => {
      const { uploader, item } = await setup();
      const body = { mediaId: item.id, licenseType: 'NON_EXCLUSIVE' };

      await request(server).post('/api/v1/orders').send(body).expect(401);
      await request(server)
        .post('/api/v1/orders')
        .set(auth(uploader.accessToken))
        .send(body)
        .expect(403);

      const pending = await registerUser(app, 'CHANNEL');
      const res = await request(server)
        .post('/api/v1/orders')
        .set(auth(pending.accessToken))
        .send(body)
        .expect(403);
      expect(res.body.message).toMatch(/not been approved/);

      const admin = await createAdmin(app);
      await request(server)
        .post('/api/v1/orders')
        .set(auth(admin.accessToken))
        .send(body)
        .expect(403);
    });

    it('validates the body', async () => {
      const { channel, item } = await setup();
      const post = (body: object) =>
        request(server)
          .post('/api/v1/orders')
          .set(auth(channel.accessToken))
          .send(body);
      await post({ mediaId: 'not-a-uuid', licenseType: 'EXCLUSIVE' }).expect(
        400,
      );
      await post({ mediaId: item.id, licenseType: 'FOREVER' }).expect(400);
      await post({
        mediaId: item.id,
        licenseType: 'EXCLUSIVE',
        amount: 1,
      }).expect(400); // unknown field
    });

    it('returns 404 for media that is missing or not approved', async () => {
      const { uploader, channel } = await setup();
      const inReview = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
      });
      for (const mediaId of [
        inReview.id,
        '00000000-0000-4000-8000-000000000000',
      ]) {
        await request(server)
          .post('/api/v1/orders')
          .set(auth(channel.accessToken))
          .send({ mediaId, licenseType: 'NON_EXCLUSIVE' })
          .expect(404);
      }
    });
  });

  describe('licence rules', () => {
    it('exclusive: only with no prior sales, and then nobody else can buy', async () => {
      const { channel, item } = await setup();
      const other = await createApprovedChannel(app, 'Other News');

      const paid = await buy(app, channel.accessToken, item.id, 'EXCLUSIVE');
      expect(paid.status).toBe('PAID');
      const [after] = await db(app)
        .select()
        .from(media)
        .where(eq(media.id, item.id));
      expect(after.exclusiveSold).toBe(true);

      for (const licenseType of ['EXCLUSIVE', 'NON_EXCLUSIVE']) {
        const res = await request(server)
          .post('/api/v1/orders')
          .set(auth(other.accessToken))
          .send({ mediaId: item.id, licenseType })
          .expect(409);
        expect(res.body.message).toMatch(/licensed exclusively/);
      }
    });

    it('exclusive is unavailable once a non-exclusive licence was sold; non-exclusive stays open', async () => {
      const { channel, item } = await setup();
      const other = await createApprovedChannel(app, 'Other News');
      await buy(app, channel.accessToken, item.id, 'NON_EXCLUSIVE');

      const res = await request(server)
        .post('/api/v1/orders')
        .set(auth(other.accessToken))
        .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
        .expect(409);
      expect(res.body.message).toMatch(
        /exclusive licence is no longer available/i,
      );

      await buy(app, other.accessToken, item.id, 'NON_EXCLUSIVE');
    });

    it('a channel can buy each media only once', async () => {
      const { channel, item } = await setup();
      await buy(app, channel.accessToken, item.id);
      const res = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(409);
      expect(res.body.message).toMatch(/already bought/);
    });

    it('re-checks the rules at payment time: an older checkout cannot be paid after an exclusive sale', async () => {
      const { channel, item } = await setup();
      const other = await createApprovedChannel(app, 'Other News');

      // Other channel opens a non-exclusive checkout first...
      const slow = await request(server)
        .post('/api/v1/orders')
        .set(auth(other.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      // ...then the exclusive licence is sold to someone else...
      await buy(app, channel.accessToken, item.id, 'EXCLUSIVE');
      // ...so the old checkout must fail instead of granting a second licence.
      const res = await request(server)
        .post(`/api/v1/orders/${slow.body.orderId}/mock-pay`)
        .set(auth(other.accessToken))
        .expect(409);
      expect(res.body.message).toMatch(/refunded/);

      const [row] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, slow.body.orderId));
      expect(row.status).toBe('FAILED');
      expect(await ledgerFor(row.id)).toHaveLength(0);
    });
  });

  describe('POST /orders/:id/mock-pay (markPaid)', () => {
    it('marks the order PAID and credits the uploader exactly once', async () => {
      const { uploader, channel, item } = await setup();
      const checkout = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);

      const first = await request(server)
        .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
        .set(auth(channel.accessToken))
        .expect(200);
      expect(first.body).toMatchObject({
        id: checkout.body.orderId,
        status: 'PAID',
        licenseType: 'NON_EXCLUSIVE',
        amount: 1_500_00,
        currency: 'INR',
        downloadCount: 0,
        media: { id: item.id, title: item.title, type: 'VIDEO' },
      });
      expect(first.body.paidAt).toBeTruthy();
      expect(first.body.media.thumbnailUrl).toMatch(
        /\/api\/v1\/files\/thumb\//,
      );

      // Idempotent: paying again returns the same order and adds nothing.
      const again = await request(server)
        .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
        .set(auth(channel.accessToken))
        .expect(200);
      expect(again.body.paidAt).toBe(first.body.paidAt);

      const credits = await ledgerFor(checkout.body.orderId);
      expect(credits).toHaveLength(1);
      expect(credits[0]).toMatchObject({
        uploaderId: uploader.user.id,
        type: 'SALE_CREDIT',
        amount: 1_050_00,
      });
    });

    it('is safe when the same order is paid many times concurrently', async () => {
      const { channel, item } = await setup();
      const checkout = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
        .expect(201);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(server)
            .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
            .set(auth(channel.accessToken)),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await ledgerFor(checkout.body.orderId)).toHaveLength(1);
    });

    it('two channels racing for the same exclusive licence: exactly one wins', async () => {
      const { uploader, item } = await setup();
      const channels = await Promise.all([
        createApprovedChannel(app, 'Channel A'),
        createApprovedChannel(app, 'Channel B'),
        createApprovedChannel(app, 'Channel C'),
      ]);

      // Every channel gets a checkout while the licence is still available...
      const checkouts = await Promise.all(
        channels.map((c) =>
          request(server)
            .post('/api/v1/orders')
            .set(auth(c.accessToken))
            .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
            .expect(201),
        ),
      );
      // ...and all of them pay at the same moment.
      const payments = await Promise.all(
        checkouts.map((checkout, i) =>
          request(server)
            .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
            .set(auth(channels[i].accessToken)),
        ),
      );

      expect(payments.map((p) => p.status).sort()).toEqual([200, 409, 409]);

      const all = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.mediaId, item.id));
      expect(all.filter((o) => o.status === 'PAID')).toHaveLength(1);
      expect(all.filter((o) => o.status === 'FAILED')).toHaveLength(2);

      const credits = await db(app)
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.uploaderId, uploader.user.id),
            eq(ledgerEntries.type, 'SALE_CREDIT'),
          ),
        );
      expect(credits).toHaveLength(1);
      expect(credits[0].amount).toBe(3_500_00); // 70% of ₹5,000
    });

    it('returns 404 for another channel’s order', async () => {
      const { channel, item } = await setup();
      const other = await createApprovedChannel(app, 'Other News');
      const checkout = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      await request(server)
        .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
        .set(auth(other.accessToken))
        .expect(404);
    });

    it('POST /orders/:id/verify rejects signatures for mock orders', async () => {
      const { channel, item } = await setup();
      const checkout = await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      await request(server)
        .post(`/api/v1/orders/${checkout.body.orderId}/verify`)
        .set(auth(channel.accessToken))
        .send({
          razorpayPaymentId: 'pay_ABC123',
          razorpaySignature: 'a'.repeat(64),
        })
        .expect(400);
    });
  });

  describe('reading orders and downloading', () => {
    async function paidOrder() {
      const ctx = await setup();
      const order = await buy(app, ctx.channel.accessToken, ctx.item.id);
      return { ...ctx, order };
    }

    it('GET /orders lists only the caller’s orders, filterable by status', async () => {
      const { channel, uploader, order } = await paidOrder();
      const second: MediaRow = await insertMedia(app, uploader.user.id, {
        title: 'Flooded underpass',
      });
      await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: second.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      const other = await createApprovedChannel(app, 'Other News');
      await buy(app, other.accessToken, second.id);

      const all = await request(server)
        .get('/api/v1/orders')
        .set(auth(channel.accessToken))
        .expect(200);
      expect(all.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
      expect(all.body.items[0].media.title).toBe('Flooded underpass'); // newest first

      const paid = await request(server)
        .get('/api/v1/orders?status=PAID')
        .set(auth(channel.accessToken))
        .expect(200);
      expect(paid.body.items.map((o: { id: string }) => o.id)).toEqual([
        order.id,
      ]);

      await request(server)
        .get('/api/v1/orders?status=NOPE')
        .set(auth(channel.accessToken))
        .expect(400);
    });

    it('GET /orders/:id is visible to the buyer and admins only', async () => {
      const { channel, uploader, order } = await paidOrder();
      await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(channel.accessToken))
        .expect(200);

      const admin = await createAdmin(app);
      const asAdmin = await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(admin.accessToken))
        .expect(200);
      expect(asAdmin.body.id).toBe(order.id);

      const other = await createApprovedChannel(app, 'Other News');
      await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(other.accessToken))
        .expect(404);
      await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(uploader.accessToken))
        .expect(403);
      await request(server)
        .get('/api/v1/orders/not-a-uuid')
        .set(auth(channel.accessToken))
        .expect(400);
    });

    it('GET /orders/:id/download returns a signed link and counts downloads', async () => {
      const { channel, order } = await paidOrder();
      const res = await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(200);
      expect(res.body.url).toMatch(
        /^http.+\/api\/v1\/files\/download\/[\w-]+\.[\w-]+$/,
      );
      expect(res.body.fileName).toBe('fire-near-gandhipuram.mp4');
      const ttl = new Date(res.body.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);

      await Promise.all([
        request(server)
          .get(`/api/v1/orders/${order.id}/download`)
          .set(auth(channel.accessToken))
          .expect(200),
        request(server)
          .get(`/api/v1/orders/${order.id}/download`)
          .set(auth(channel.accessToken))
          .expect(200),
      ]);
      const view = await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(channel.accessToken))
        .expect(200);
      expect(view.body.downloadCount).toBe(3);
    });

    it('download is refused for unpaid orders, other buyers and taken-down media', async () => {
      const { channel, item, order } = await paidOrder();
      const other = await createApprovedChannel(app, 'Other News');
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(other.accessToken))
        .expect(404);

      const unpaid = await request(server)
        .post('/api/v1/orders')
        .set(auth(other.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);
      await request(server)
        .get(`/api/v1/orders/${unpaid.body.orderId}/download`)
        .set(auth(other.accessToken))
        .expect(409);

      await db(app)
        .update(media)
        .set({ status: 'REMOVED' })
        .where(eq(media.id, item.id));
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(409);
    });

    it('a channel whose approval is later revoked can still read its orders but not buy', async () => {
      const { channel, item, order } = await paidOrder();
      await db(app)
        .update(channelProfiles)
        .set({ status: 'REJECTED' })
        .where(eq(channelProfiles.userId, channel.user.id));
      await request(server)
        .get(`/api/v1/orders/${order.id}`)
        .set(auth(channel.accessToken))
        .expect(200);
      await request(server)
        .post('/api/v1/orders')
        .set(auth(channel.accessToken))
        .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
        .expect(403);
    });
  });
});
