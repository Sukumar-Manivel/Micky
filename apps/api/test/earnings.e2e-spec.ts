import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import {
  ledgerEntries,
  orders,
  payoutDetailChanges,
  payouts,
  uploaderProfiles,
} from '../src/db/schema.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { auth, createAdmin, db, resetDb, startApp } from './helpers.js';
import {
  buy,
  clearRateLimits,
  createApprovedChannel,
  createUploader,
  drainCommerceQueue,
  insertMedia,
  releaseHeldCredits,
  setUpi,
} from './orders.fixtures.js';

describe('Earnings (e2e)', () => {
  let app: NestExpressApplication;
  let server: ReturnType<NestExpressApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await startApp();
    server = app.getHttpServer();
    await drainCommerceQueue(app);
  });
  beforeEach(async () => {
    await resetDb(app);
    clearRateLimits(app);
  });
  afterAll(async () => {
    await app.close();
  });

  /**
   * An uploader with a UPI ID and two sales: ₹1,500 non-exclusive (₹1,050 share) and
   * ₹2,000 exclusive photo (₹1,400). With `released`, the 7-day hold has ended.
   */
  async function uploaderWithSales({ released = true } = {}) {
    const uploader = await createUploader(app);
    const channel = await createApprovedChannel(app, 'Kovai News');
    const video = await insertMedia(app, uploader.user.id);
    const photo = await insertMedia(app, uploader.user.id, {
      type: 'PHOTO',
      title: 'Collapsed wall on Avinashi Road',
      priceNonExclusive: 500_00,
      priceExclusive: 2_000_00,
    });
    const videoOrder = await buy(
      app,
      channel.accessToken,
      video.id,
      'NON_EXCLUSIVE',
    );
    await buy(app, channel.accessToken, photo.id, 'EXCLUSIVE');
    await setUpi(app, uploader, 'priya.k-92@okaxis').expect(200);
    if (released) await releaseHeldCredits(app, uploader.user.id);
    return { uploader, channel, video, photo, videoOrder };
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
        .send({
          upiId: '  9876543210@ybl ',
          currentPassword: uploader.password,
        })
        .expect(200);
      expect(res.body.user).toMatchObject({
        id: uploader.user.id,
        uploader: { upiId: '9876543210@ybl' },
      });
      // The first UPI ID has no cooling-off: there was nowhere else for money to go.
      expect(res.body.payoutDetails).toEqual({
        upiId: '9876543210@ybl',
        changedAt: null,
        payoutsAllowedFrom: null,
      });
    });

    it('requires the current password (M4)', async () => {
      const uploader = await createUploader(app);
      await request(server)
        .put('/api/v1/me/payout-details')
        .set(auth(uploader.accessToken))
        .send({ upiId: 'thief@okaxis' })
        .expect(400);
      const wrong = await request(server)
        .put('/api/v1/me/payout-details')
        .set(auth(uploader.accessToken))
        .send({ upiId: 'thief@okaxis', currentPassword: 'not-my-password' })
        .expect(403);
      expect(wrong.body.message).toMatch(/password/);
      const [profile] = await db(app)
        .select()
        .from(uploaderProfiles)
        .where(eq(uploaderProfiles.userId, uploader.user.id));
      expect(profile.upiId).toBeNull();
      expect(await db(app).select().from(payoutDetailChanges)).toHaveLength(0);
    });

    it('a change starts a 24-hour cooling-off before any payout, and is audited (M4)', async () => {
      const { uploader } = await uploaderWithSales();
      // Payouts to the original ID work.
      await requestPayout(uploader.accessToken, 100_00).expect(201);

      const changed = await request(server)
        .put('/api/v1/me/payout-details')
        .set(auth(uploader.accessToken))
        .set('User-Agent', 'e2e-agent')
        .send({ upiId: 'new.id@oksbi', currentPassword: uploader.password })
        .expect(200);
      const allowedFrom = new Date(
        changed.body.payoutDetails.payoutsAllowedFrom,
      ).getTime();
      expect(allowedFrom - Date.now()).toBeGreaterThan(23.9 * 3600_000);
      expect(allowedFrom - Date.now()).toBeLessThanOrEqual(24 * 3600_000);

      const blocked = await requestPayout(uploader.accessToken, 100_00).expect(
        400,
      );
      expect(blocked.body.message).toMatch(/UPI ID was changed recently/);
      const summary = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(summary.body.payoutDetails).toMatchObject({
        upiId: 'new.id@oksbi',
        payoutsAllowedFrom: changed.body.payoutDetails.payoutsAllowedFrom,
      });

      const audit = await db(app)
        .select()
        .from(payoutDetailChanges)
        .where(eq(payoutDetailChanges.userId, uploader.user.id));
      expect(audit.map((a) => [a.oldUpiId, a.newUpiId])).toEqual(
        expect.arrayContaining([
          [null, 'priya.k-92@okaxis'],
          ['priya.k-92@okaxis', 'new.id@oksbi'],
        ]),
      );
      expect(audit.find((a) => a.newUpiId === 'new.id@oksbi')?.userAgent).toBe(
        'e2e-agent',
      );

      // Saving the same ID again is not a change and does not restart the clock.
      await setUpi(app, uploader, 'new.id@oksbi').expect(200);
      expect(await db(app).select().from(payoutDetailChanges)).toHaveLength(2);

      // After 24 hours, payouts work again (to the new ID).
      await db(app)
        .update(uploaderProfiles)
        .set({ upiChangedAt: new Date(Date.now() - 24 * 3600_000 - 1000) })
        .where(eq(uploaderProfiles.userId, uploader.user.id));
      const ok = await requestPayout(uploader.accessToken, 100_00).expect(201);
      expect(ok.body.upiId).toBe('new.id@oksbi');
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
          .send({ upiId, currentPassword: uploader.password })
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
        available: 2_450_00,
        onHold: 0,
        nextReleaseAt: null,
        holdDays: 7,
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
        available: 0,
        onHold: 0,
        nextReleaseAt: null,
        holdDays: 7,
        totalEarned: 0,
        totalPaidOut: 0,
        pendingPayouts: 0,
        salesCount: 0,
        payoutDetails: {
          upiId: null,
          changedAt: null,
          payoutsAllowedFrom: null,
        },
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
        status: 'PAID',
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
      expect(res.body.message).toMatch(
        /at most your available balance of ₹2450\.00/,
      );
      await requestPayout(uploader.accessToken, 100.5).expect(400);
      await request(server)
        .post('/api/v1/me/payouts')
        .set(auth(uploader.accessToken))
        .send({})
        .expect(400);

      // Exactly the whole balance is allowed.
      await requestPayout(uploader.accessToken, 2_450_00).expect(201);

      const noUpi = await createUploader(app);
      await db(app).insert(ledgerEntries).values({
        uploaderId: noUpi.user.id,
        type: 'ADJUSTMENT',
        amount: 500_00,
        note: 'Test opening balance',
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
  describe('hold period, reversals and the append-only ledger (H2, L6)', () => {
    it('sale credits are on hold for 7 days: no payout until the hold ends', async () => {
      const { uploader } = await uploaderWithSales({ released: false });
      const summary = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(summary.body).toMatchObject({
        balance: 2_450_00,
        available: 0,
        onHold: 2_450_00,
        totalEarned: 2_450_00,
      });
      const release =
        new Date(summary.body.nextReleaseAt).getTime() - Date.now();
      expect(release).toBeGreaterThan(6.9 * 24 * 3600_000);
      // The oldest sale is released first.
      expect(summary.body.recent.at(-1).availableAt).toBe(
        summary.body.nextReleaseAt,
      );

      const blocked = await requestPayout(uploader.accessToken, 100_00).expect(
        400,
      );
      expect(blocked.body.message).toMatch(/available balance of ₹0\.00/);
      expect(blocked.body.message).toMatch(/₹2450\.00 more is on hold/);
      expect(await db(app).select().from(payouts)).toHaveLength(0);

      // Seven days later...
      await releaseHeldCredits(app, uploader.user.id);
      await requestPayout(uploader.accessToken, 2_450_00).expect(201);
    });

    it('a refund after the money was paid out leaves a negative balance that blocks payouts', async () => {
      const { uploader, videoOrder } = await uploaderWithSales();
      await requestPayout(uploader.accessToken, 2_450_00).expect(201);

      const [order] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, videoOrder.id));
      const result = await app
        .get(OrdersService)
        .reverseSaleForRefund(
          order.providerPaymentId!,
          'Refunded in the dashboard',
        );
      expect(result).toBe('reversed');

      const summary = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(summary.body).toMatchObject({
        balance: -1_050_00,
        available: -1_050_00,
        totalEarned: 1_400_00,
        salesCount: 1,
      });
      expect(summary.body.recent[0]).toMatchObject({
        type: 'SALE_REVERSAL',
        amount: -1_050_00,
        mediaTitle: 'Fire near Gandhipuram',
      });
      await requestPayout(uploader.accessToken, 100_00).expect(400);

      const sales = await request(server)
        .get('/api/v1/me/sales')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(
        sales.body.items.map((x: { status: string }) => x.status).sort(),
      ).toEqual(['PAID', 'REFUNDED']);
    });

    it('a refund inside the hold period cancels the held credit without touching the available balance', async () => {
      const { uploader, videoOrder } = await uploaderWithSales({
        released: false,
      });
      const [order] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, videoOrder.id));
      await app
        .get(OrdersService)
        .reverseSaleForRefund(order.providerPaymentId!, 'Refunded');
      const summary = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(summary.body).toMatchObject({
        balance: 1_400_00,
        available: 0,
        onHold: 1_400_00,
      });
    });

    it('the ledger is append-only and money rows are checked by the database', async () => {
      const { uploader } = await uploaderWithSales();
      await expect(
        db(app)
          .update(ledgerEntries)
          .set({ amount: 1 })
          .where(eq(ledgerEntries.uploaderId, uploader.user.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/append-only/) },
      });
      await expect(
        db(app)
          .delete(ledgerEntries)
          .where(eq(ledgerEntries.uploaderId, uploader.user.id)),
      ).rejects.toMatchObject({
        cause: { message: expect.stringMatching(/append-only/) },
      });
      // A positive payout debit, an adjustment without a note, a zero amount: all refused.
      for (const values of [
        { type: 'PAYOUT_DEBIT' as const, amount: 100 },
        { type: 'ADJUSTMENT' as const, amount: 100 },
        { type: 'ADJUSTMENT' as const, amount: 0, note: 'zero' },
        { type: 'SALE_CREDIT' as const, amount: 100 },
      ]) {
        await expect(
          db(app)
            .insert(ledgerEntries)
            .values({ uploaderId: uploader.user.id, ...values }),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
      }
      await expect(
        db(app)
          .insert(payouts)
          .values({
            uploaderId: uploader.user.id,
            amount: 0,
            upiId: 'x@okaxis',
          }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });
});
