// Test fixtures shared by the commerce e2e tests (orders, earnings, admin, reports).
// Media rows are inserted directly with Drizzle: the upload pipeline is tested elsewhere.
import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  channelProfiles,
  incidents,
  ledgerEntries,
  media,
  orders,
  verifications,
} from '../src/db/schema.js';
import { COMMERCE_QUEUE } from '../src/orders/refunds.constants.js';
import { auth, db, registerUser } from './helpers.js';

export type MediaRow = typeof media.$inferSelect;

/**
 * Registration is rate limited (10/min per IP) and every test registers several users
 * from the same IP, so the rate-limit counters (in Redis) are cleared before each test.
 * It is async: callers must await it, or a test can start before the counters are reset.
 */
export { clearRateLimits } from './helpers.js';

export async function createUploader(app: NestExpressApplication) {
  return registerUser(app, 'UPLOADER');
}

/** A news channel whose organisation an admin has approved (set directly in the database). */
export async function createApprovedChannel(
  app: NestExpressApplication,
  organization = 'Kovai News',
) {
  const channel = await registerUser(app, 'CHANNEL', { organization });
  await db(app)
    .update(channelProfiles)
    .set({ status: 'APPROVED' })
    .where(eq(channelProfiles.userId, channel.user.id));
  return channel;
}

export async function createIncident(app: NestExpressApplication) {
  const now = new Date();
  const [row] = await db(app)
    .insert(incidents)
    .values({
      title: 'Fire near Gandhipuram',
      category: 'FIRE',
      geohash: 'tf2a3b',
      latitude: 11.0168,
      longitude: 76.9558,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning();
  return row;
}

/** Inserts a media item (APPROVED by default) with a verification row. */
export async function insertMedia(
  app: NestExpressApplication,
  uploaderId: string,
  overrides: Partial<typeof media.$inferInsert> = {},
): Promise<MediaRow> {
  const id = randomUUID();
  const [row] = await db(app)
    .insert(media)
    .values({
      id,
      uploaderId,
      type: 'VIDEO',
      status: 'APPROVED',
      title: 'Fire near Gandhipuram',
      description: 'Warehouse fire seen from the bus stand',
      category: 'FIRE',
      latitude: 11.0168,
      longitude: 76.9558,
      geohash: 'tf2a3b',
      locationName: 'Gandhipuram, Coimbatore',
      capturedAt: new Date(Date.now() - 60 * 60 * 1000),
      originalKey: `originals/${id}/source.mp4`,
      originalName: 'VID_20261010.MP4',
      mimeType: 'video/mp4',
      sizeBytes: 1_000_000,
      checksum: randomUUID().replace(/-/g, ''),
      thumbKey: `thumbs/${id}.jpg`,
      priceNonExclusive: 1_500_00,
      priceExclusive: 5_000_00,
      ...overrides,
    })
    .returning();
  await db(app)
    .insert(verifications)
    .values({
      mediaId: row.id,
      aiScore: 0.12,
      aiModel: 'test-model',
      framesScored: 8,
      c2paStatus: 'absent',
      metadata: { gps: { lat: 11.0168, lng: 76.9558 }, device: 'Pixel 9' },
      signals: [
        {
          code: 'AI_SCORE_LOW',
          level: 'positive',
          message: 'Low AI likelihood',
        },
      ],
      riskLevel: 'LOW',
    });
  return row;
}

/** Buys a licence through the real API with the mock provider. Returns the paid OrderView. */
export async function buy(
  app: NestExpressApplication,
  token: string,
  mediaId: string,
  licenseType: 'NON_EXCLUSIVE' | 'EXCLUSIVE' = 'NON_EXCLUSIVE',
) {
  const checkout = await request(app.getHttpServer())
    .post('/api/v1/orders')
    .set(auth(token))
    .send({ mediaId, licenseType })
    .expect(201);
  const paid = await request(app.getHttpServer())
    .post(`/api/v1/orders/${checkout.body.orderId}/mock-pay`)
    .set(auth(token))
    .expect(200);
  return paid.body as { id: string; status: string; amount: number };
}

/** Saves a UPI ID through the API (the current password is required). */
export function setUpi(
  app: NestExpressApplication,
  user: { accessToken: string; password: string },
  upiId: string,
) {
  return request(app.getHttpServer())
    .put('/api/v1/me/payout-details')
    .set(auth(user.accessToken))
    .send({ upiId, currentPassword: user.password });
}

/**
 * Ends the hold period of every sale credit of this uploader, as if the hold days had
 * passed. The ledger is append-only (a trigger refuses UPDATE), so this opens the
 * documented maintenance window for one transaction, exactly as an operator would.
 */
export async function releaseHeldCredits(
  app: NestExpressApplication,
  uploaderId: string,
) {
  await db(app).transaction(async (tx) => {
    await tx.execute(sql`set local micky.ledger_maintenance = 'on'`);
    await tx
      .update(ledgerEntries)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(ledgerEntries.uploaderId, uploaderId));
  });
}

/** Removes every job of the commerce queue, so a test never sees a job left by another run. */
export async function drainCommerceQueue(app: NestExpressApplication) {
  const queue = app.get<Queue>(getQueueToken(COMMERCE_QUEUE));
  await queue.obliterate({ force: true });
}

/** Waits (polling the database) until the order reaches `status`; the refund job runs in the background. */
export async function waitForOrderStatus(
  app: NestExpressApplication,
  orderId: string,
  status: (typeof orders.$inferSelect)['status'],
) {
  await expect
    .poll(
      async () =>
        (
          await db(app)
            .select({ status: orders.status })
            .from(orders)
            .where(eq(orders.id, orderId))
        )[0]?.status,
      { timeout: 10_000, interval: 100 },
    )
    .toBe(status);
}
