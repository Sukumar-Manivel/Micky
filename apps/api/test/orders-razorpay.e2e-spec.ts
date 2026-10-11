import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { MockInstance } from 'vitest';
import {
  ledgerEntries,
  media,
  orders,
  refunds,
  webhookEvents,
} from '../src/db/schema.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPayment,
} from '../src/orders/payments/payment-provider.js';
import { auth, db, resetDb, startApp } from './helpers.js';
import {
  clearRateLimits,
  createApprovedChannel,
  createUploader,
  drainCommerceQueue,
  insertMedia,
} from './orders.fixtures.js';

// This file runs the app with PAYMENTS_PROVIDER=razorpay and test secrets. AppConfig reads
// the environment when the app is created, so the variables are set before startApp()
// and restored afterwards. No request ever reaches Razorpay: orders are inserted directly,
// and the provider's createOrder, fetchPayment and refund are stubbed.
const KEY_ID = 'rzp_test_MickyKey';
const KEY_SECRET = 'test_key_secret_for_e2e';
const WEBHOOK_SECRET = 'test_webhook_secret_for_e2e';

const ENV = {
  PAYMENTS_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: KEY_ID,
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const hmac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('hex');

describe('Orders (e2e, Razorpay provider)', () => {
  let app: NestExpressApplication;
  let server: ReturnType<NestExpressApplication['getHttpServer']>;
  const savedEnv: Record<string, string | undefined> = {};
  let provider: PaymentProvider;
  /** Razorpay's Refunds API, stubbed: accepted as "pending", finished later by webhook. */
  let refundApi: MockInstance<PaymentProvider['refund']>;
  /** Razorpay's payments.fetch, stubbed per test. */
  let fetchPayment: MockInstance<PaymentProvider['fetchPayment']>;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    app = await startApp();
    server = app.getHttpServer();
    provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
    refundApi = vi.spyOn(provider, 'refund');
    fetchPayment = vi.spyOn(provider, 'fetchPayment');
    await drainCommerceQueue(app);
  });
  beforeEach(async () => {
    await resetDb(app);
    await clearRateLimits(app);
    refundApi.mockReset();
    refundApi.mockImplementation(async ({ paymentId }) => ({
      refundId: `rfnd_${paymentId.slice(4)}`,
      status: 'pending',
    }));
    fetchPayment.mockReset();
    fetchPayment.mockRejectedValue(
      new Error('fetchPayment not stubbed in this test'),
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** An approved channel with a CREATED Razorpay order for a fresh media item. */
  async function createdOrder(
    licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' = 'NON_EXCLUSIVE',
  ) {
    const uploader = await createUploader(app);
    const channel = await createApprovedChannel(app);
    const item = await insertMedia(app, uploader.user.id);
    const amount =
      licenseType === 'EXCLUSIVE'
        ? item.priceExclusive
        : item.priceNonExclusive;
    const [order] = await db(app)
      .insert(orders)
      .values({
        buyerId: channel.user.id,
        mediaId: item.id,
        licenseType,
        amount,
        platformFee: Math.floor(amount * 0.3),
        uploaderShare: amount - Math.floor(amount * 0.3),
        provider: 'razorpay',
        providerOrderId: `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      })
      .returning();
    return { uploader, channel, item, order };
  }

  function webhook(
    body: object,
    opts: { eventId?: string; secret?: string; signature?: string } = {},
  ) {
    // Sign the exact string we send: this is what Razorpay does with its raw body.
    const raw = JSON.stringify(body);
    const req = request(server)
      .post('/api/v1/payments/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${randomUUID()}`);
    const signature =
      opts.signature ?? hmac(opts.secret ?? WEBHOOK_SECRET, raw);
    if (signature) req.set('X-Razorpay-Signature', signature);
    return req.send(raw);
  }

  const paymentEvent = (
    event: string,
    providerOrderId: string,
    paymentId: string,
    amount: number,
  ) => ({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: providerOrderId,
          amount,
          currency: 'INR',
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const credits = (orderId: string) =>
    db(app)
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.orderId, orderId));

  const orderRow = async (orderId: string) =>
    (await db(app).select().from(orders).where(eq(orders.id, orderId)))[0];

  const refundsFor = (orderId: string) =>
    db(app).select().from(refunds).where(eq(refunds.orderId, orderId));

  /** What Razorpay's payments.fetch returns for a payment of this order. */
  const capturedPayment = (
    order: { providerOrderId: string; amount: number },
    paymentId: string,
    overrides: Partial<ProviderPayment> = {},
  ): ProviderPayment => ({
    id: paymentId,
    orderId: order.providerOrderId,
    status: 'captured',
    amount: order.amount,
    currency: 'INR',
    createdAt: new Date(),
    ...overrides,
  });

  const verifyBody = (providerOrderId: string, paymentId: string) => ({
    razorpayPaymentId: paymentId,
    razorpaySignature: hmac(KEY_SECRET, `${providerOrderId}|${paymentId}`),
  });

  const refundEvent = (
    event: string,
    paymentId: string,
    refundId: string,
    amount: number,
  ) => ({
    entity: 'event',
    event,
    payload: {
      refund: {
        entity: {
          id: refundId,
          payment_id: paymentId,
          amount,
          currency: 'INR',
        },
      },
      payment: { entity: { id: paymentId, amount, currency: 'INR' } },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const disputeEvent = (event: string, paymentId: string) => ({
    entity: 'event',
    event,
    payload: {
      dispute: {
        entity: { id: 'disp_Test0001', payment_id: paymentId, amount: 1 },
      },
      payment: { entity: { id: paymentId } },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  /** Pays a CREATED order through the webhook and returns it PAID. */
  async function paidOrder(
    licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' = 'NON_EXCLUSIVE',
  ) {
    const ctx = await createdOrder(licenseType);
    const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    await webhook(
      paymentEvent(
        'payment.captured',
        ctx.order.providerOrderId,
        paymentId,
        ctx.order.amount,
      ),
    ).expect(200);
    return { ...ctx, paymentId };
  }

  describe('POST /orders', () => {
    it('creates a Razorpay order and returns the key id and Razorpay order id for Checkout', async () => {
      const uploader = await createUploader(app);
      const channel = await createApprovedChannel(app);
      const item = await insertMedia(app, uploader.user.id);

      const provider = app.get<PaymentProvider>(PAYMENT_PROVIDER);
      const createOrder = vi
        .spyOn(provider, 'createOrder')
        .mockResolvedValue({ providerOrderId: 'order_TESTabc123' });
      try {
        const res = await request(server)
          .post('/api/v1/orders')
          .set(auth(channel.accessToken))
          .send({ mediaId: item.id, licenseType: 'EXCLUSIVE' })
          .expect(201);
        expect(res.body).toMatchObject({
          amount: 5_000_00,
          provider: 'razorpay',
          razorpay: { keyId: KEY_ID, orderId: 'order_TESTabc123' },
        });
        expect(createOrder).toHaveBeenCalledWith({
          amountPaise: 5_000_00,
          receipt: res.body.orderId,
          notes: {
            orderId: res.body.orderId,
            mediaId: item.id,
            licenseType: 'EXCLUSIVE',
          },
        });
      } finally {
        createOrder.mockRestore();
      }
    });

    it('mock-pay does not exist when Razorpay is configured', async () => {
      const { channel, order } = await createdOrder();
      await request(server)
        .post(`/api/v1/orders/${order.id}/mock-pay`)
        .set(auth(channel.accessToken))
        .expect(404);
    });
  });

  describe('POST /orders/:id/verify', () => {
    it('accepts a valid signature for a captured payment, marks the order PAID and is idempotent', async () => {
      const { uploader, channel, order } = await createdOrder();
      const paymentId = 'pay_Verify0001';
      const body = verifyBody(order.providerOrderId, paymentId);
      fetchPayment.mockResolvedValue(capturedPayment(order, paymentId));

      const res = await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(channel.accessToken))
        .send(body)
        .expect(200);
      expect(res.body).toMatchObject({ id: order.id, status: 'PAID' });

      await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(channel.accessToken))
        .send(body)
        .expect(200);

      const rows = await credits(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        uploaderId: uploader.user.id,
        amount: 1_050_00,
      });
      const [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.providerPaymentId).toBe(paymentId);
      expect(fetchPayment).toHaveBeenCalledWith(paymentId);
    });

    it('does not grant a licence for a payment that is only authorised (M5); the capture webhook does', async () => {
      const { channel, order } = await createdOrder();
      const paymentId = 'pay_Authorised01';
      fetchPayment.mockResolvedValue(
        capturedPayment(order, paymentId, { status: 'authorized' }),
      );
      const res = await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(channel.accessToken))
        .send(verifyBody(order.providerOrderId, paymentId))
        .expect(200);
      expect(res.body.status).toBe('CREATED');
      expect(await credits(order.id)).toHaveLength(0);
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(409);

      // Razorpay captures it (auto-capture) and tells us by webhook.
      const hook = await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          paymentId,
          order.amount,
        ),
      ).expect(200);
      expect(hook.body.status).toBe('paid');
      expect((await orderRow(order.id)).status).toBe('PAID');
    });

    it('refuses a captured payment of the wrong amount and refunds it', async () => {
      const { channel, order } = await createdOrder();
      const paymentId = 'pay_WrongAmount1';
      fetchPayment.mockResolvedValue(
        capturedPayment(order, paymentId, { amount: order.amount - 100 }),
      );
      await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(channel.accessToken))
        .send(verifyBody(order.providerOrderId, paymentId))
        .expect(409);
      expect((await orderRow(order.id)).status).toBe('CREATED');
      await expect
        .poll(async () => (await refundsFor(order.id))[0]?.providerRefundId)
        .toBe('rfnd_WrongAmount1');
      expect(refundApi).toHaveBeenCalledWith(
        expect.objectContaining({ paymentId, amountPaise: order.amount - 100 }),
      );
    });

    it('answers 502 when Razorpay cannot be reached, without granting anything', async () => {
      const { channel, order } = await createdOrder();
      const paymentId = 'pay_Unreachable1';
      await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(channel.accessToken))
        .send(verifyBody(order.providerOrderId, paymentId))
        .expect(502);
      expect((await orderRow(order.id)).status).toBe('CREATED');
    });

    it('rejects a wrong signature, and a signature that belongs to a different order', async () => {
      const { channel, order } = await createdOrder();
      const paymentId = 'pay_Verify0002';
      const post = (signature: string) =>
        request(server)
          .post(`/api/v1/orders/${order.id}/verify`)
          .set(auth(channel.accessToken))
          .send({ razorpayPaymentId: paymentId, razorpaySignature: signature });

      await post(
        hmac('some-other-secret', `${order.providerOrderId}|${paymentId}`),
      ).expect(400);
      // Valid HMAC, but for another order id: the server must use its own stored id.
      await post(hmac(KEY_SECRET, `order_CheaperOrder01|${paymentId}`)).expect(
        400,
      );
      // Malformed input never reaches the service.
      await post('not-hex').expect(400);

      const [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.status).toBe('CREATED');
      expect(await credits(order.id)).toHaveLength(0);
    });

    it('is only available to the buyer', async () => {
      const { order } = await createdOrder();
      const other = await createApprovedChannel(app, 'Other News');
      const paymentId = 'pay_Verify0003';
      await request(server)
        .post(`/api/v1/orders/${order.id}/verify`)
        .set(auth(other.accessToken))
        .send({
          razorpayPaymentId: paymentId,
          razorpaySignature: hmac(
            KEY_SECRET,
            `${order.providerOrderId}|${paymentId}`,
          ),
        })
        .expect(404);
    });
  });

  describe('POST /payments/razorpay/webhook', () => {
    it('payment.captured marks the order PAID; the same event delivered twice credits once', async () => {
      const { item, order } = await createdOrder('EXCLUSIVE');
      const body = paymentEvent(
        'payment.captured',
        order.providerOrderId,
        'pay_Hook0001',
        order.amount,
      );

      const first = await webhook(body, { eventId: 'evt_same_1' }).expect(200);
      expect(first.body).toEqual({ received: true, status: 'paid' });
      const retry = await webhook(body, { eventId: 'evt_same_1' }).expect(200);
      expect(retry.body).toEqual({
        received: true,
        status: 'already processed',
      });

      const [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.status).toBe('PAID');
      expect(await credits(order.id)).toHaveLength(1);
      const [m] = await db(app)
        .select()
        .from(media)
        .where(eq(media.id, item.id));
      expect(m.exclusiveSold).toBe(true);
      expect(await db(app).select().from(webhookEvents)).toHaveLength(1);
    });

    it('order.paid after payment.captured (different event ids) is still a single credit', async () => {
      const { order } = await createdOrder();
      await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_Hook0002',
          order.amount,
        ),
      ).expect(200);
      const second = await webhook({
        ...paymentEvent(
          'order.paid',
          order.providerOrderId,
          'pay_Hook0002',
          order.amount,
        ),
      }).expect(200);
      expect(second.body.status).toBe('already_paid');
      expect(await credits(order.id)).toHaveLength(1);
    });

    it('webhook and browser verify racing for the same payment credit once', async () => {
      const { channel, order } = await createdOrder();
      const paymentId = 'pay_Hook0003';
      fetchPayment.mockResolvedValue(capturedPayment(order, paymentId));
      await Promise.all([
        webhook(
          paymentEvent(
            'payment.captured',
            order.providerOrderId,
            paymentId,
            order.amount,
          ),
        ).expect(200),
        request(server)
          .post(`/api/v1/orders/${order.id}/verify`)
          .set(auth(channel.accessToken))
          .send({
            razorpayPaymentId: paymentId,
            razorpaySignature: hmac(
              KEY_SECRET,
              `${order.providerOrderId}|${paymentId}`,
            ),
          })
          .expect(200),
      ]);
      expect(await credits(order.id)).toHaveLength(1);
    });

    it('rejects a missing or invalid signature with 400 and changes nothing', async () => {
      const { order } = await createdOrder();
      const body = paymentEvent(
        'payment.captured',
        order.providerOrderId,
        'pay_Hook0004',
        order.amount,
      );

      await webhook(body, { secret: 'wrong-secret' }).expect(400);
      await webhook(body, { signature: '' }).expect(400);
      // Signed with the right secret, but a different body: the amount was tampered with.
      const signedFor = hmac(WEBHOOK_SECRET, JSON.stringify(body));
      await webhook(
        { ...body, tampered: true },
        { signature: signedFor },
      ).expect(400);

      const [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.status).toBe('CREATED');
      expect(await db(app).select().from(webhookEvents)).toHaveLength(0);
    });

    it('payment.failed marks a CREATED order FAILED, and a later successful payment still wins', async () => {
      const { order } = await createdOrder();
      const failed = await webhook(
        paymentEvent(
          'payment.failed',
          order.providerOrderId,
          'pay_Declined',
          order.amount,
        ),
      ).expect(200);
      expect(failed.body.status).toBe('failed');
      let [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.status).toBe('FAILED');

      // The buyer retries with another card inside the same Razorpay checkout.
      await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_Retry',
          order.amount,
        ),
      ).expect(200);
      [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved.status).toBe('PAID');
      expect(await credits(order.id)).toHaveLength(1);
    });

    it('acknowledges unknown events and orders; refunds underpayments and wrong currencies (L5)', async () => {
      const { order } = await createdOrder();
      const unknownEvent = await webhook({
        event: 'refund.created',
        payload: {},
      }).expect(200);
      expect(unknownEvent.body.status).toBe('ignored');

      const unknownOrder = await webhook(
        paymentEvent('payment.captured', 'order_DoesNotExist', 'pay_X', 100),
      ).expect(200);
      expect(unknownOrder.body.status).toBe('ignored: unknown order');

      const under = await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_Under',
          order.amount - 1,
        ),
      ).expect(200);
      expect(under.body.status).toBe('refund_pending: amount mismatch');

      const usd = paymentEvent(
        'payment.captured',
        order.providerOrderId,
        'pay_Usd',
        order.amount,
      );
      usd.payload.payment.entity.currency = 'USD';
      expect((await webhook(usd).expect(200)).body.status).toBe(
        'refund_pending: amount mismatch',
      );

      // No amount at all: never grant.
      const noAmount = paymentEvent(
        'payment.captured',
        order.providerOrderId,
        'pay_NoAmount',
        0,
      ) as {
        payload: { payment: { entity: Record<string, unknown> } };
      };
      delete noAmount.payload.payment.entity.amount;
      expect((await webhook(noAmount).expect(200)).body.status).toBe(
        'ignored: no amount',
      );

      expect(await credits(order.id)).toHaveLength(0);
      expect((await orderRow(order.id)).status).toBe('CREATED');
      await expect
        .poll(async () =>
          (await refundsFor(order.id)).map((r) => r.providerPaymentId).sort(),
        )
        .toEqual(['pay_Under', 'pay_Usd']);
    });

    it('ignores a captured event for an order of another provider', async () => {
      const { order } = await createdOrder();
      await db(app)
        .update(orders)
        .set({ provider: 'mock' })
        .where(eq(orders.id, order.id));
      const res = await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_Other',
          order.amount,
        ),
      ).expect(200);
      expect(res.body.status).toBe('ignored: not a Razorpay order');
      expect(await credits(order.id)).toHaveLength(0);
    });

    it('the same signed body replayed under a new event id is not processed again (L5)', async () => {
      const { order } = await createdOrder();
      const body = paymentEvent(
        'payment.captured',
        order.providerOrderId,
        'pay_Replay01',
        order.amount,
      );
      const first = await webhook(body, { eventId: 'evt_original' }).expect(
        200,
      );
      expect(first.body.status).toBe('paid');
      // The event-id header is not covered by the signature, so an attacker can change it.
      const replay = await webhook(body, {
        eventId: 'evt_forged_new_id',
      }).expect(200);
      expect(replay.body.status).toBe('already processed');
      expect(await db(app).select().from(webhookEvents)).toHaveLength(1);
      expect(await credits(order.id)).toHaveLength(1);
    });

    it('a captured payment for a licence that was sold meanwhile is refunded (H1)', async () => {
      const { item, order } = await createdOrder('EXCLUSIVE');
      // Someone else's non-exclusive order is paid first, so exclusive is no longer possible.
      const rival = await createApprovedChannel(app, 'Rival News');
      const [rivalOrder] = await db(app)
        .insert(orders)
        .values({
          buyerId: rival.user.id,
          mediaId: item.id,
          licenseType: 'NON_EXCLUSIVE',
          amount: item.priceNonExclusive,
          platformFee: 0,
          uploaderShare: item.priceNonExclusive,
          provider: 'razorpay',
          providerOrderId: 'order_RivalOrder01',
        })
        .returning();
      await webhook(
        paymentEvent(
          'payment.captured',
          rivalOrder.providerOrderId,
          'pay_Rival',
          rivalOrder.amount,
        ),
      ).expect(200);

      const res = await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_Late',
          order.amount,
        ),
      ).expect(200);
      expect(res.body.status).toBe('refund_pending');
      expect(await orderRow(order.id)).toMatchObject({
        status: 'REFUND_PENDING',
        providerPaymentId: 'pay_Late',
      });
      expect(await credits(order.id)).toHaveLength(0);

      // The job asks Razorpay for a full refund, keyed on the payment, and stores its id.
      await expect
        .poll(async () => (await refundsFor(order.id))[0]?.providerRefundId)
        .toBe('rfnd_Late');
      const [refund] = await refundsFor(order.id);
      expect(refundApi).toHaveBeenCalledWith({
        paymentId: 'pay_Late',
        amountPaise: order.amount,
        receipt: refund.id,
        notes: { orderId: order.id, refundId: refund.id },
      });
      expect(refund.status).toBe('PENDING'); // Razorpay finishes it asynchronously

      // refund.processed completes it; a second delivery changes nothing.
      const done = await webhook(
        refundEvent('refund.processed', 'pay_Late', 'rfnd_Late', order.amount),
      ).expect(200);
      expect(done.body.status).toBe('refund_processed');
      await webhook(
        refundEvent('refund.processed', 'pay_Late', 'rfnd_Late', order.amount),
      ).expect(200);
      expect(await orderRow(order.id)).toMatchObject({ status: 'REFUNDED' });
      expect((await refundsFor(order.id))[0]).toMatchObject({
        status: 'PROCESSED',
        providerRefundId: 'rfnd_Late',
      });
      // The rival's sale is untouched.
      expect((await orderRow(rivalOrder.id)).status).toBe('PAID');
    });

    it('refund.failed marks our refund FAILED and the order REFUND_FAILED for an admin', async () => {
      const { item, order } = await createdOrder('EXCLUSIVE');
      await db(app)
        .update(media)
        .set({ status: 'REMOVED' })
        .where(eq(media.id, item.id));
      await webhook(
        paymentEvent(
          'payment.captured',
          order.providerOrderId,
          'pay_TakenDown',
          order.amount,
        ),
      ).expect(200);
      await expect
        .poll(async () => (await refundsFor(order.id))[0]?.providerRefundId)
        .toBe('rfnd_TakenDown');
      const res = await webhook(
        refundEvent(
          'refund.failed',
          'pay_TakenDown',
          'rfnd_TakenDown',
          order.amount,
        ),
      ).expect(200);
      expect(res.body.status).toBe('refund_failed');
      expect((await orderRow(order.id)).status).toBe('REFUND_FAILED');
      expect((await refundsFor(order.id))[0]).toMatchObject({
        status: 'FAILED',
      });
    });
  });

  describe('after the sale: refunds made in the dashboard and chargebacks (H2)', () => {
    it('refund.processed for a sold licence revokes it and reverses the uploader credit, once', async () => {
      const { uploader, channel, order, paymentId } = await paidOrder();
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(200);

      const event = refundEvent(
        'refund.processed',
        paymentId,
        'rfnd_Dashboard1',
        order.amount,
      );
      const res = await webhook(event, { eventId: 'evt_refund_1' }).expect(200);
      expect(res.body.status).toBe('sale_reversed');
      // Delivered twice (Razorpay retry), and once more under another event id with a new body.
      expect(
        (await webhook(event, { eventId: 'evt_refund_1' }).expect(200)).body
          .status,
      ).toBe('already processed');
      const again = await webhook(
        {
          ...refundEvent(
            'refund.processed',
            paymentId,
            'rfnd_Dashboard1',
            order.amount,
          ),
          created_at: 1,
        },
        { eventId: 'evt_refund_2' },
      ).expect(200);
      expect(again.body.status).toBe('ignored: unchanged payment');

      expect(await orderRow(order.id)).toMatchObject({ status: 'REFUNDED' });
      const rows = await credits(order.id);
      expect(rows.map((r) => [r.type, r.amount]).sort()).toEqual([
        ['SALE_CREDIT', 1_050_00],
        ['SALE_REVERSAL', -1_050_00],
      ]);
      expect(rows.every((r) => r.uploaderId === uploader.user.id)).toBe(true);
      // The buyer can no longer download it.
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(409);
      expect(refundApi).not.toHaveBeenCalled(); // nothing for us to refund
    });

    it('a chargeback revokes the licence and reverses the credit; winning it reinstates both', async () => {
      const { channel, order, paymentId } = await paidOrder();
      const opened = await webhook(
        disputeEvent('payment.dispute.created', paymentId),
      ).expect(200);
      expect(opened.body.status).toBe('disputed');
      expect((await orderRow(order.id)).status).toBe('DISPUTED');
      expect((await credits(order.id)).map((r) => r.type).sort()).toEqual([
        'SALE_CREDIT',
        'SALE_REVERSAL',
      ]);
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(409);
      // Later stages of the same dispute change nothing more.
      expect(
        (
          await webhook(
            disputeEvent('payment.dispute.under_review', paymentId),
          ).expect(200)
        ).body.status,
      ).toBe('ignored: unchanged payment');

      const won = await webhook(
        disputeEvent('payment.dispute.won', paymentId),
      ).expect(200);
      expect(won.body.status).toBe('dispute_won');
      expect((await orderRow(order.id)).status).toBe('PAID');
      const rows = await credits(order.id);
      expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(1_050_00);
      expect(rows.map((r) => r.type).sort()).toEqual([
        'SALE_CREDIT',
        'SALE_REINSTATEMENT',
        'SALE_REVERSAL',
      ]);
      await request(server)
        .get(`/api/v1/orders/${order.id}/download`)
        .set(auth(channel.accessToken))
        .expect(200);
    });

    it('dispute and refund events for unknown payments are acknowledged', async () => {
      expect(
        (
          await webhook(
            disputeEvent('payment.dispute.created', 'pay_Unknown01'),
          ).expect(200)
        ).body.status,
      ).toBe('ignored: unknown payment');
      expect(
        (
          await webhook(
            refundEvent('refund.processed', 'pay_Unknown01', 'rfnd_X', 100),
          ).expect(200)
        ).body.status,
      ).toBe('ignored: unknown payment');
      expect(
        (
          await webhook(
            refundEvent('refund.failed', 'pay_Unknown01', 'rfnd_X', 100),
          ).expect(200)
        ).body.status,
      ).toBe('ignored: unknown refund');
    });
  });
});
