// Test fixtures shared by the commerce e2e tests (orders, earnings, admin, reports).
// Media rows are inserted directly with Drizzle: the upload pipeline is tested elsewhere.
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  getStorageToken,
  type ThrottlerStorageService,
} from '@nestjs/throttler';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  channelProfiles,
  incidents,
  media,
  verifications,
} from '../src/db/schema.js';
import { auth, db, registerUser } from './helpers.js';

export type MediaRow = typeof media.$inferSelect;

/**
 * Registration is rate limited (10/min per IP) and every test registers several users
 * from the same IP, so the in-memory rate limit counters are cleared before each test.
 */
export function clearRateLimits(app: NestExpressApplication) {
  // The in-memory storage keeps hit counts in two internal maps; its public
  // onApplicationShutdown() clears both (it restarts its sweep timer on the next hit).
  app.get<ThrottlerStorageService>(getStorageToken()).onApplicationShutdown();
}

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
