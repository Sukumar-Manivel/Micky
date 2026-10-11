import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { ledgerEntries, payouts } from '../src/db/schema.js';
import { auth, createAdmin, db, resetDb, startApp } from './helpers.js';
import {
  buy,
  clearRateLimits,
  createApprovedChannel,
  createUploader,
  insertMedia,
} from './orders.fixtures.js';

describe('Earnings (e2e)', () => {
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

  /** An uploader with a UPI ID and two sales: ₹1,500 non-exclusive (₹1,050 share) and ₹2,000 exclusive photo (₹1,400). */
  async function uploaderWithSales() {
    const uploader = await createUploader(app);
    const channel = await createApprovedChannel(app, 'Kovai News');
    const video = await insertMedia(app, uploader.user.id);
    const photo = await insertMedia(app, uploader.user.id, {
      type: 'PHOTO',
      title: 'Collapsed wall on Avinashi Road',
      priceNonExclusive: 500_00,
      priceExclusive: 2_000_00,
    });
    await buy(app, channel.accessToken, video.id, 'NON_EXCLUSIVE');
    await buy(app, channel.accessToken, photo.id, 'EXCLUSIVE');
    await request(server)
      .put('/api/v1/me/payout-details')
      .set(auth(uploader.accessToken))
      .send({ upiId: 'priya.k-92@okaxis' })
      .expect(200);
    return { uploader, channel, video, photo };
  }

  const requestPayout = (token: string, amount: number) =>
    request(server)
      .post('/api/v1/me/payouts')
      .set(auth(token))
      .send({ amount });

  it('is for uploaders only', async () => {
    const channel = await createApprovedChannel(app);
    const admin = await createAdmin(app);
    await request(server).get('/api/v1/me/earnings').expect(401);
    await request(server)
      .get('/api/v1/me/earnings')
      .set(auth(channel.accessToken))
      .expect(403);
    await request(server)
      .get('/api/v1/me/earnings')
      .set(auth(admin.accessToken))
      .expect(403);
    await requestPayout(channel.accessToken, 100_00).expect(403);
  });

  describe('PUT /me/payout-details', () => {
    it('saves a valid UPI ID and returns the user', async () => {
      const uploader = await createUploader(app);
      const res = await request(server)
        .put('/api/v1/me/payout-details')
        .set(auth(uploader.accessToken))
        .send({ upiId: '  9876543210@ybl ' })
        .expect(200);
      expect(res.body.user).toMatchObject({
        id: uploader.user.id,
        uploader: { upiId: '9876543210@ybl' },
      });
    });

    it('rejects malformed UPI IDs', async () => {
      const uploader = await createUploader(app);
      for (const upiId of [
        'no-at-sign',
        'a@b',
        '@okaxis',
        'name@ok axis',
        'name@123',
        'x'.repeat(98) + '@ab',
        '',
      ]) {
        await request(server)
          .put('/api/v1/me/payout-details')
          .set(auth(uploader.accessToken))
          .send({ upiId })
          .expect(400);
      }
    });
  });

  describe('GET /me/earnings, /me/ledger, /me/sales', () => {
    it('computes balance and totals from the ledger', async () => {
      const { uploader } = await uploaderWithSales();
      const res = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(res.body).toMatchObject({
        balance: 2_450_00,
        totalEarned: 2_450_00,
        totalPaidOut: 0,
        pendingPayouts: 0,
        salesCount: 2,
      });
      expect(res.body.recent).toHaveLength(2);
      expect(res.body.recent[0]).toMatchObject({
        type: 'SALE_CREDIT',
        amount: 1_400_00,
        mediaTitle: 'Collapsed wall on Avinashi Road',
      });
    });

    it('returns zeros for a new uploader', async () => {
      const uploader = await createUploader(app);
      const res = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(res.body).toEqual({
        balance: 0,
        totalEarned: 0,
        totalPaidOut: 0,
        pendingPayouts: 0,
        salesCount: 0,
        recent: [],
      });
    });

    it('paginates the ledger, newest first', async () => {
      const { uploader } = await uploaderWithSales();
      const page1 = await request(server)
        .get('/api/v1/me/ledger?pageSize=1')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(page1.body).toMatchObject({ page: 1, pageSize: 1, total: 2 });
      expect(page1.body.items[0].amount).toBe(1_400_00);
      const page2 = await request(server)
        .get('/api/v1/me/ledger?pageSize=1&page=2')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(page2.body.items[0]).toMatchObject({
        amount: 1_050_00,
        mediaTitle: 'Fire near Gandhipuram',
      });
      await request(server)
        .get('/api/v1/me/ledger?pageSize=101')
        .set(auth(uploader.accessToken))
        .expect(400);
    });

    it('lists sales with the buyer’s organisation, and only the caller’s own', async () => {
      const { uploader } = await uploaderWithSales();
      const res = await request(server)
        .get('/api/v1/me/sales')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items[0]).toMatchObject({
        mediaTitle: 'Collapsed wall on Avinashi Road',
        licenseType: 'EXCLUSIVE',
        amount: 2_000_00,
        uploaderShare: 1_400_00,
        buyerOrganization: 'Kovai News',
      });
      expect(res.body.items[0].paidAt).toBeTruthy();

      const someoneElse = await createUploader(app);
      const empty = await request(server)
        .get('/api/v1/me/sales')
        .set(auth(someoneElse.accessToken))
        .expect(200);
      expect(empty.body).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('POST /me/payouts', () => {
    it('debits the ledger immediately and lists the payout', async () => {
      const { uploader } = await uploaderWithSales();
      const res = await requestPayout(uploader.accessToken, 1_000_00).expect(
        201,
      );
      expect(res.body).toMatchObject({
        amount: 1_000_00,
        upiId: 'priya.k-92@okaxis',
        status: 'REQUESTED',
        reference: null,
        processedAt: null,
      });

      const earnings = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(earnings.body).toMatchObject({
        balance: 1_450_00,
        totalEarned: 2_450_00,
        pendingPayouts: 1_000_00,
      });
      expect(earnings.body.recent[0]).toMatchObject({
        type: 'PAYOUT_DEBIT',
        amount: -1_000_00,
      });

      const list = await request(server)
        .get('/api/v1/me/payouts')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(list.body).toMatchObject({
        total: 1,
        items: [{ id: res.body.id }],
      });
    });

    it('validates minimum, balance, UPI ID and the amount format', async () => {
      const { uploader } = await uploaderWithSales();
      let res = await requestPayout(uploader.accessToken, 99_99).expect(400);
      expect(res.body.message).toMatch(/minimum payout is ₹100\.00/);
      res = await requestPayout(uploader.accessToken, 2_450_01).expect(400);
      expect(res.body.message).toMatch(/at most your balance of ₹2450\.00/);
      await requestPayout(uploader.accessToken, 100.5).expect(400);
      await request(server)
        .post('/api/v1/me/payouts')
        .set(auth(uploader.accessToken))
        .send({})
        .expect(400);

      // Exactly the whole balance is allowed.
      await requestPayout(uploader.accessToken, 2_450_00).expect(201);

      const noUpi = await createUploader(app);
      await db(app)
        .insert(ledgerEntries)
        .values({
          uploaderId: noUpi.user.id,
          type: 'ADJUSTMENT',
          amount: 500_00,
        });
      res = await requestPayout(noUpi.accessToken, 200_00).expect(400);
      expect(res.body.message).toMatch(/UPI ID/);
    });

    it('concurrent payout requests can never overdraw the balance', async () => {
      const { uploader } = await uploaderWithSales(); // balance ₹2,450
      // Ten simultaneous requests for ₹800 each: at most three (₹2,400) can fit.
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          requestPayout(uploader.accessToken, 800_00),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(3);
      expect(statuses.filter((s) => s === 400)).toHaveLength(7);

      const [{ balance }] = await db(app)
        .select({
          balance: sql<number>`sum(${ledgerEntries.amount})`.mapWith(Number),
        })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.uploaderId, uploader.user.id));
      expect(balance).toBe(50_00);
      expect(await db(app).select().from(payouts)).toHaveLength(3);
    });
  });
});
