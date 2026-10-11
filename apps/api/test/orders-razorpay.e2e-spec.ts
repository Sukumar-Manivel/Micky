import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ledgerEntries,
  media,
  orders,
  webhookEvents,
} from '../src/db/schema.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../src/orders/payments/payment-provider.js';
import { auth, db, resetDb, startApp } from './helpers.js';
import {
  clearRateLimits,
  createApprovedChannel,
  createUploader,
  insertMedia,
} from './orders.fixtures.js';

// This file runs the app with PAYMENTS_PROVIDER=razorpay and test secrets. AppConfig reads
// the environment when the app is created, so the variables are set before startApp()
// and restored afterwards. No request ever reaches Razorpay: orders are inserted directly
// or the provider's createOrder is stubbed.
const KEY_ID = 'rzp_test_FirstFrameKey';
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

  beforeAll(async () => {
    for (const [key, value] of Object.entries(ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    app = await startApp();
    server = app.getHttpServer();
  });
  beforeEach(async () => {
    await resetDb(app);
    clearRateLimits(app);
  });
  afterAll(async () => {
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
    it('accepts a valid signature, marks the order PAID and is idempotent', async () => {
      const { uploader, channel, order } = await createdOrder();
      const paymentId = 'pay_Verify0001';
      const body = {
        razorpayPaymentId: paymentId,
        razorpaySignature: hmac(
          KEY_SECRET,
          `${order.providerOrderId}|${paymentId}`,
        ),
      };

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

    it('acknowledges unknown events, unknown orders and underpayments without granting anything', async () => {
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
          'pay_Y',
          order.amount - 1,
        ),
      ).expect(200);
      expect(under.body.status).toBe('ignored: amount mismatch');
      expect(await credits(order.id)).toHaveLength(0);
    });

    it('a captured payment for a licence that was sold meanwhile marks the order FAILED (needs refund)', async () => {
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
      expect(res.body.status).toBe('licence_unavailable');
      const [saved] = await db(app)
        .select()
        .from(orders)
        .where(eq(orders.id, order.id));
      expect(saved).toMatchObject({
        status: 'FAILED',
        providerPaymentId: 'pay_Late',
      });
      expect(await credits(order.id)).toHaveLength(0);
    });
  });
});
