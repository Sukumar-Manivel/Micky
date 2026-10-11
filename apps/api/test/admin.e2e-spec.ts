import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import {
  ledgerEntries,
  media,
  orders,
  payouts,
  refunds,
  reports,
  uploaderProfiles,
} from '../src/db/schema.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../src/orders/payments/payment-provider.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { RefundsService } from '../src/orders/refunds.service.js';
import { IncidentsService } from '../src/incidents/incidents.service.js';
import { RealtimeService } from '../src/realtime/realtime.service.js';
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
  createIncident,
  createUploader,
  drainCommerceQueue,
  insertMedia,
  setUpi,
  waitForOrderStatus,
} from './orders.fixtures.js';

describe('Admin (e2e)', () => {
  let app: NestExpressApplication;
  let server: ReturnType<NestExpressApplication['getHttpServer']>;
  let adminToken: string;

  // IncidentsService and RealtimeService belong to other modules (and may still be
  // stubs). Spying on the app's instances checks that admin calls them correctly,
  // without depending on their implementation.
  let recompute: MockInstance<IncidentsService['recompute']>;
  let emit: MockInstance<RealtimeService['emitToChannels']>;

  beforeAll(async () => {
    app = await startApp();
    server = app.getHttpServer();
    recompute = vi
      .spyOn(app.get(IncidentsService), 'recompute')
      .mockResolvedValue(undefined);
    emit = vi
      .spyOn(app.get(RealtimeService), 'emitToChannels')
      .mockReturnValue(undefined);
    await drainCommerceQueue(app);
  });
  beforeEach(async () => {
    await resetDb(app);
    await clearRateLimits(app);
    recompute.mockClear();
    emit.mockClear();
    adminToken = (await createAdmin(app)).accessToken;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const asAdmin = (method: 'get' | 'post', path: string) =>
    request(server)[method](`/api/v1/admin${path}`).set(auth(adminToken));

  it('is for admins only', async () => {
    const channel = await createApprovedChannel(app);
    const uploader = await createUploader(app);
    await request(server).get('/api/v1/admin/stats').expect(401);
    await request(server)
      .get('/api/v1/admin/stats')
      .set(auth(channel.accessToken))
      .expect(403);
    await request(server)
      .get('/api/v1/admin/review-queue')
      .set(auth(uploader.accessToken))
      .expect(403);
    await request(server)
      .post(`/api/v1/admin/channels/${channel.user.id}/approve`)
      .set(auth(channel.accessToken))
      .expect(403);
  });

  it('GET /admin/stats aggregates users, media, orders, payouts and reports', async () => {
    const uploader = await createUploader(app);
    const channel = await createApprovedChannel(app);
    await registerUser(app, 'CHANNEL'); // pending
    const item = await insertMedia(app, uploader.user.id);
    await insertMedia(app, uploader.user.id, { status: 'IN_REVIEW' });
    await insertMedia(app, uploader.user.id, { status: 'PROCESSING' });
    await insertMedia(app, uploader.user.id, { status: 'REJECTED' });
    await buy(app, channel.accessToken, item.id, 'EXCLUSIVE');
    await db(app).insert(payouts).values({
      uploaderId: uploader.user.id,
      amount: 300_00,
      upiId: 'a.b@okaxis',
    });
    await db(app)
      .insert(reports)
      .values({ reporterEmail: 'r@test.local', reason: 'PRIVACY' });

    const res = await asAdmin('get', '/stats').expect(200);
    expect(res.body).toEqual({
      users: { uploaders: 1, channels: 2, pendingChannels: 1 },
      media: { processing: 1, inReview: 1, approved: 1, rejected: 1 },
      orders: {
        paid: 1,
        revenue: 5_000_00,
        platformFees: 1_500_00,
        disputed: 0,
      },
      refunds: { pending: 0, failed: 0 },
      payouts: { requested: 1, requestedAmount: 300_00 },
      reports: { open: 1 },
    });
  });

  describe('media moderation', () => {
    it('review queue: IN_REVIEW only, oldest first, risk filter, full metadata and uploader', async () => {
      const uploader = await createUploader(app);
      const older = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
        title: 'Older upload',
        createdAt: new Date(Date.now() - 60_000),
      });
      await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
        title: 'Newer upload',
      });
      await insertMedia(app, uploader.user.id, { status: 'APPROVED' });

      const res = await asAdmin('get', '/review-queue').expect(200);
      expect(res.body.total).toBe(2);
      expect(res.body.items.map((m: { title: string }) => m.title)).toEqual([
        'Older upload',
        'Newer upload',
      ]);
      expect(res.body.items[0]).toMatchObject({
        id: older.id,
        status: 'IN_REVIEW',
        uploader: {
          id: uploader.user.id,
          name: 'Test UPLOADER',
          email: uploader.user.email,
        },
        verification: { riskLevel: 'LOW', metadata: { device: 'Pixel 9' } },
      });

      const high = await asAdmin('get', '/review-queue?risk=HIGH').expect(200);
      expect(high.body).toMatchObject({ items: [], total: 0 });
      await asAdmin('get', '/review-queue?risk=EXTREME').expect(400);
    });

    it('approve: IN_REVIEW → APPROVED, recomputes the incident and notifies channels', async () => {
      const uploader = await createUploader(app);
      const incident = await createIncident(app);
      const item = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
        incidentId: incident.id,
      });

      const res = await asAdmin('post', `/media/${item.id}/approve`)
        .send({ note: 'Looks genuine' })
        .expect(200);
      expect(res.body).toMatchObject({
        id: item.id,
        status: 'APPROVED',
        reviewNote: 'Looks genuine',
      });
      expect(res.body.verification.metadata).toEqual({
        gps: { lat: 11.0168, lng: 76.9558 },
        device: 'Pixel 9',
      });

      expect(recompute).toHaveBeenCalledWith(incident.id);
      expect(emit).toHaveBeenCalledWith({
        type: 'media.approved',
        mediaId: item.id,
        incidentId: incident.id,
        title: item.title,
        category: 'FIRE',
      });

      const [row] = await db(app)
        .select()
        .from(media)
        .where(eq(media.id, item.id));
      expect(row.reviewedAt).toBeTruthy();

      // Approving twice is a conflict, and has no side effects the second time.
      await asAdmin('post', `/media/${item.id}/approve`).send({}).expect(409);
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('approve without an incident does not recompute', async () => {
      const uploader = await createUploader(app);
      const item = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
      });
      await asAdmin('post', `/media/${item.id}/approve`).send({}).expect(200);
      expect(recompute).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('reject requires a note and only works on IN_REVIEW media', async () => {
      const uploader = await createUploader(app);
      const item = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
      });
      await asAdmin('post', `/media/${item.id}/reject`).send({}).expect(400);
      await asAdmin('post', `/media/${item.id}/reject`)
        .send({ note: 'x' })
        .expect(400);

      const res = await asAdmin('post', `/media/${item.id}/reject`)
        .send({ note: 'AI-generated: frames show warped text' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        reviewNote: 'AI-generated: frames show warped text',
      });

      await asAdmin('post', `/media/${item.id}/reject`)
        .send({ note: 'again' })
        .expect(409);
      await asAdmin(
        'post',
        '/media/00000000-0000-4000-8000-000000000000/reject',
      )
        .send({ note: 'nope' })
        .expect(404);
      expect(emit).not.toHaveBeenCalled();
    });

    it('remove takes down APPROVED media and recomputes its incident', async () => {
      const uploader = await createUploader(app);
      const incident = await createIncident(app);
      const item = await insertMedia(app, uploader.user.id, {
        incidentId: incident.id,
      });
      const inReview = await insertMedia(app, uploader.user.id, {
        status: 'IN_REVIEW',
      });

      const res = await asAdmin('post', `/media/${item.id}/remove`)
        .send({ note: 'Court order 12/2026' })
        .expect(200);
      expect(res.body.status).toBe('REMOVED');
      expect(recompute).toHaveBeenCalledWith(incident.id);

      await asAdmin('post', `/media/${inReview.id}/remove`)
        .send({ note: 'Not approved yet' })
        .expect(409);
    });
  });

  describe('channels', () => {
    it('lists, approves and rejects news channels', async () => {
      const pending = await registerUser(app, 'CHANNEL', {
        organization: 'Pending Times',
      });
      await createApprovedChannel(app, 'Approved Daily');

      const list = await asAdmin('get', '/channels?status=PENDING').expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({
        id: pending.user.id,
        role: 'CHANNEL',
        channel: { organization: 'Pending Times', status: 'PENDING' },
      });
      expect(list.body.items[0]).not.toHaveProperty('passwordHash');
      expect((await asAdmin('get', '/channels').expect(200)).body.total).toBe(
        2,
      );

      const approved = await asAdmin(
        'post',
        `/channels/${pending.user.id}/approve`,
      ).expect(200);
      expect(approved.body.channel.status).toBe('APPROVED');

      // The channel can now use the marketplace-only routes, e.g. create orders.
      const uploader = await createUploader(app);
      const item = await insertMedia(app, uploader.user.id);
      await request(server)
        .post('/api/v1/orders')
        .set(auth(pending.accessToken))
        .send({ mediaId: item.id, licenseType: 'NON_EXCLUSIVE' })
        .expect(201);

      await asAdmin('post', `/channels/${pending.user.id}/reject`)
        .send({})
        .expect(400);
      const rejected = await asAdmin(
        'post',
        `/channels/${pending.user.id}/reject`,
      )
        .send({ note: 'Could not verify the organisation' })
        .expect(200);
      expect(rejected.body.channel.status).toBe('REJECTED');
    });

    it('returns 404 for users that are not channels', async () => {
      const uploader = await createUploader(app);
      await asAdmin('post', `/channels/${uploader.user.id}/approve`).expect(
        404,
      );
    });
  });

  describe('payouts', () => {
    async function requestedPayout() {
      const uploader = await createUploader(app);
      await db(app).insert(ledgerEntries).values({
        uploaderId: uploader.user.id,
        type: 'ADJUSTMENT',
        amount: 1_000_00,
        note: 'Test opening balance',
      });
      await setUpi(app, uploader, 'ravi@oksbi').expect(200);
      const payout = await request(server)
        .post('/api/v1/me/payouts')
        .set(auth(uploader.accessToken))
        .send({ amount: 600_00 })
        .expect(201);
      return { uploader, payout: payout.body as { id: string } };
    }

    const balanceOf = async (token: string) =>
      (
        await request(server)
          .get('/api/v1/me/earnings')
          .set(auth(token))
          .expect(200)
      ).body.balance as number;

    it('lists payouts with the uploader and marks one paid with a reference', async () => {
      const { uploader, payout } = await requestedPayout();
      const list = await asAdmin('get', '/payouts?status=REQUESTED').expect(
        200,
      );
      expect(list.body.items[0]).toMatchObject({
        id: payout.id,
        amount: 600_00,
        upiId: 'ravi@oksbi',
        uploader: { id: uploader.user.id, email: uploader.user.email },
        upiChangedAt: null,
        upiChangedRecently: false,
      });

      await asAdmin('post', `/payouts/${payout.id}/mark-paid`)
        .send({})
        .expect(400);
      const paid = await asAdmin('post', `/payouts/${payout.id}/mark-paid`)
        .send({ reference: 'UTR4567890123' })
        .expect(200);
      expect(paid.body).toMatchObject({
        status: 'PAID',
        reference: 'UTR4567890123',
      });
      expect(paid.body.processedAt).toBeTruthy();

      // Already processed: cannot be paid again or rejected.
      await asAdmin('post', `/payouts/${payout.id}/mark-paid`)
        .send({ reference: 'UTR-again' })
        .expect(409);
      await asAdmin('post', `/payouts/${payout.id}/reject`)
        .send({ note: 'too late' })
        .expect(409);

      expect(await balanceOf(uploader.accessToken)).toBe(400_00);
      const earnings = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(earnings.body).toMatchObject({
        totalPaidOut: 600_00,
        pendingPayouts: 0,
      });
    });

    it('reject returns the money with a PAYOUT_REVERSAL, exactly once even under concurrency', async () => {
      const { uploader, payout } = await requestedPayout();
      expect(await balanceOf(uploader.accessToken)).toBe(400_00);

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          asAdmin('post', `/payouts/${payout.id}/reject`).send({
            note: 'UPI ID does not exist',
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(results.find((r) => r.status === 200)!.body).toMatchObject({
        status: 'REJECTED',
        note: 'UPI ID does not exist',
      });

      const reversals = await db(app)
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.type, 'PAYOUT_REVERSAL'));
      expect(reversals).toHaveLength(1);
      expect(reversals[0]).toMatchObject({
        amount: 600_00,
        payoutId: payout.id,
        uploaderId: uploader.user.id,
      });
      expect(await balanceOf(uploader.accessToken)).toBe(1_000_00);

      await asAdmin(
        'post',
        '/payouts/00000000-0000-4000-8000-000000000000/reject',
      )
        .send({ note: 'nope' })
        .expect(404);
    });
  });

  it('flags payouts whose UPI ID was changed recently (M4)', async () => {
    const uploader = await createUploader(app);
    await db(app).insert(ledgerEntries).values({
      uploaderId: uploader.user.id,
      type: 'ADJUSTMENT',
      amount: 1_000_00,
      note: 'Test opening balance',
    });
    await setUpi(app, uploader, 'first@oksbi').expect(200);
    await setUpi(app, uploader, 'second@oksbi').expect(200);
    // The 24 h cooling-off is over, but the change is still recent for the admin.
    const changedAt = new Date(Date.now() - 25 * 3600_000);
    await db(app)
      .update(uploaderProfiles)
      .set({ upiChangedAt: changedAt })
      .where(eq(uploaderProfiles.userId, uploader.user.id));
    await request(server)
      .post('/api/v1/me/payouts')
      .set(auth(uploader.accessToken))
      .send({ amount: 500_00 })
      .expect(201);
    const list = await asAdmin('get', '/payouts?status=REQUESTED').expect(200);
    expect(list.body.items[0]).toMatchObject({
      upiId: 'second@oksbi',
      upiChangedAt: changedAt.toISOString(),
      upiChangedRecently: true,
    });
  });

  describe('refunds, disputes and adjustments (H1, H2)', () => {
    /** A channel whose exclusive payment lost the race: its order is REFUND_PENDING. */
    async function lostRace() {
      const uploader = await createUploader(app);
      const winner = await createApprovedChannel(app, 'Winner News');
      const loser = await createApprovedChannel(app, 'Loser News');
      const item = await insertMedia(app, uploader.user.id);
      const slow = await request(server)
        .post('/api/v1/orders')
        .set(auth(loser.accessToken))
        .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
        .expect(201);
      await buy(app, winner.accessToken, item.id, 'EXCLUSIVE');
      await request(server)
        .post(`/api/v1/orders/${slow.body.orderId}/mock-pay`)
        .set(auth(loser.accessToken))
        .expect(409);
      return { uploader, loser, item, orderId: slow.body.orderId as string };
    }

    it('lists refunds with buyer and media, and retries a failed one until it is processed', async () => {
      const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
      const service = app.get(RefundsService);
      const refundApi = vi
        .spyOn(provider, 'refund')
        .mockRejectedValue(new Error('gateway down'));
      const enqueue = vi.spyOn(service, 'enqueue').mockResolvedValue(undefined);
      let ctx: Awaited<ReturnType<typeof lostRace>>;
      try {
        ctx = await lostRace();
        const [row] = await db(app)
          .select()
          .from(orders)
          .where(eq(orders.id, ctx.orderId));
        await expect(
          service.process(row.providerPaymentId!, { finalAttempt: true }),
        ).rejects.toThrow();
      } finally {
        refundApi.mockRestore();
        enqueue.mockRestore();
      }

      const stats = await asAdmin('get', '/stats').expect(200);
      expect(stats.body.refunds).toEqual({ pending: 0, failed: 1 });

      const list = await asAdmin('get', '/refunds?status=FAILED').expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({
        status: 'FAILED',
        amount: 5_000_00,
        attempts: 1,
        lastError: 'gateway down',
        order: {
          id: ctx.orderId,
          status: 'REFUND_FAILED',
          licenseType: 'EXCLUSIVE',
        },
        media: { id: ctx.item.id, title: ctx.item.title },
        buyer: { id: ctx.loser.user.id, organization: 'Loser News' },
      });
      expect(list.body.items[0].reason).toMatch(/licensed exclusively/);
      await asAdmin('get', '/refunds?status=NOPE').expect(400);

      const retried = await asAdmin(
        'post',
        `/refunds/${list.body.items[0].id}/retry`,
      ).expect(200);
      expect(retried.body).toEqual({
        id: list.body.items[0].id,
        status: 'PENDING',
      });
      await waitForOrderStatus(app, ctx.orderId, 'REFUNDED');
      const [refund] = await db(app)
        .select()
        .from(refunds)
        .where(eq(refunds.orderId, ctx.orderId));
      expect(refund).toMatchObject({ status: 'PROCESSED', lastError: null });

      // A processed refund cannot be retried; an unknown one is 404.
      await asAdmin('post', `/refunds/${refund.id}/retry`).expect(409);
      await asAdmin(
        'post',
        '/refunds/00000000-0000-4000-8000-000000000000/retry',
      ).expect(404);
    });

    it('lists orders by status, e.g. disputed ones', async () => {
      const uploader = await createUploader(app);
      const channel = await createApprovedChannel(app, 'Disputing News');
      const item = await insertMedia(app, uploader.user.id);
      const order = await buy(app, channel.accessToken, item.id);
      const [row] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      await app
        .get(OrdersService)
        .openDispute(row.providerPaymentId!, 'Chargeback (created)');

      const stats = await asAdmin('get', '/stats').expect(200);
      expect(stats.body.orders).toMatchObject({ paid: 0, disputed: 1 });
      const list = await asAdmin('get', '/orders?status=DISPUTED').expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0]).toMatchObject({
        id: order.id,
        status: 'DISPUTED',
        statusReason: 'Chargeback (created)',
        providerPaymentId: row.providerPaymentId,
        buyer: { id: channel.user.id, organization: 'Disputing News' },
        media: { id: item.id },
      });
      expect(
        (await asAdmin('get', '/orders?status=PAID').expect(200)).body.total,
      ).toBe(0);
    });

    it('writes a ledger ADJUSTMENT with a mandatory note and the admin as author', async () => {
      const uploader = await createUploader(app);
      const channel = await createApprovedChannel(app);
      const post = (body: object) =>
        asAdmin('post', '/ledger-adjustments').send(body);

      await post({ uploaderId: uploader.user.id, amount: 500_00 }).expect(400); // no note
      await post({
        uploaderId: uploader.user.id,
        amount: 0,
        note: 'nothing',
      }).expect(400);
      await post({
        uploaderId: uploader.user.id,
        amount: 1.5,
        note: 'half',
      }).expect(400);
      await post({ amount: 100, note: 'who?' }).expect(400);
      await post({
        uploaderEmail: channel.user.email,
        amount: 100,
        note: 'not an uploader',
      }).expect(404);

      const credit = await post({
        uploaderEmail: uploader.user.email.toUpperCase(),
        amount: 250_00,
        note: 'Goodwill for a late payout',
      }).expect(201);
      expect(credit.body).toMatchObject({
        type: 'ADJUSTMENT',
        amount: 250_00,
        note: 'Goodwill for a late payout',
        uploaderId: uploader.user.id,
      });
      await post({
        uploaderId: uploader.user.id,
        amount: -300_00,
        note: 'Recover a duplicate credit',
      }).expect(201);

      const rows = await db(app)
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.uploaderId, uploader.user.id));
      expect(rows.map((r) => r.amount).sort()).toEqual([-300_00, 250_00]);
      expect(rows.every((r) => r.createdBy !== null)).toBe(true);
      // Balances may go negative; the uploader sees the adjustment with its note.
      const summary = await request(server)
        .get('/api/v1/me/earnings')
        .set(auth(uploader.accessToken))
        .expect(200);
      expect(summary.body).toMatchObject({
        balance: -50_00,
        available: -50_00,
      });
      await request(server)
        .post('/api/v1/admin/ledger-adjustments')
        .set(auth(uploader.accessToken))
        .send({
          uploaderId: uploader.user.id,
          amount: 100,
          note: 'self-service',
        })
        .expect(403);
    });
  });

  describe('reports', () => {
    async function openReport(mediaId?: string) {
      const res = await request(server)
        .post('/api/v1/reports')
        .send({
          mediaId,
          reporterEmail: 'person@test.local',
          reason: 'PRIVACY',
          details: 'My face is visible',
        })
        .expect(201);
      return res.body as { id: string };
    }

    it('lists reports and dismisses one', async () => {
      const report = await openReport();
      const list = await asAdmin('get', '/reports?status=OPEN').expect(200);
      expect(list.body.items[0]).toMatchObject({
        id: report.id,
        mediaId: null,
        reporterEmail: 'person@test.local',
        reason: 'PRIVACY',
        details: 'My face is visible',
        status: 'OPEN',
        resolution: null,
      });

      const dismissed = await asAdmin('post', `/reports/${report.id}/dismiss`)
        .send({ resolution: 'Person is not identifiable' })
        .expect(200);
      expect(dismissed.body).toMatchObject({
        status: 'DISMISSED',
        resolution: 'Person is not identifiable',
      });
      expect(dismissed.body.resolvedAt).toBeTruthy();

      await asAdmin('post', `/reports/${report.id}/resolve`)
        .send({ resolution: 'changed mind' })
        .expect(409);
    });

    it('resolve with removeMedia takes the media down in the same step', async () => {
      const uploader = await createUploader(app);
      const incident = await createIncident(app);
      const item = await insertMedia(app, uploader.user.id, {
        incidentId: incident.id,
      });
      const report = await openReport(item.id);

      const res = await asAdmin('post', `/reports/${report.id}/resolve`)
        .send({ resolution: 'Victim identifiable; removed', removeMedia: true })
        .expect(200);
      expect(res.body.status).toBe('RESOLVED');

      const [row] = await db(app)
        .select()
        .from(media)
        .where(eq(media.id, item.id));
      expect(row.status).toBe('REMOVED');
      expect(recompute).toHaveBeenCalledWith(incident.id);
    });

    it('resolve with removeMedia on a report without media is a conflict and changes nothing', async () => {
      const report = await openReport();
      await asAdmin('post', `/reports/${report.id}/resolve`)
        .send({ resolution: 'remove it', removeMedia: true })
        .expect(409);
      const [row] = await db(app)
        .select()
        .from(reports)
        .where(eq(reports.id, report.id));
      expect(row.status).toBe('OPEN'); // the transaction was rolled back
    });
  });
});
