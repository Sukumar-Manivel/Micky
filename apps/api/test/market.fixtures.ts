// Test data for the market, stream and realtime e2e tests.
// Uploads and processing are built by another module, so these helpers insert
// "already processed" rows directly and write small fake preview files.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JwtService } from '@nestjs/jwt';
import type { AccessTokenPayload } from '../src/common/auth.guards.js';
import { AppConfig } from '../src/config/app-config.js';
import {
  channelProfiles,
  incidents,
  media,
  orders,
  type Role,
  uploaderProfiles,
  users,
  verifications,
} from '../src/db/schema.js';
import { StorageService, storageKeys } from '../src/storage/storage.service.js';
import { db } from './helpers.js';

type MediaInsert = typeof media.$inferInsert;
type IncidentInsert = typeof incidents.$inferInsert;

// Kochi and nearby points, for distance tests.
export const KOCHI = { lat: 9.9312, lng: 76.2673 };
export const ALUVA = { lat: 10.1004, lng: 76.357 }; // about 21 km from Kochi
export const CHENNAI = { lat: 13.0827, lng: 80.2707 }; // about 550 km from Kochi

/** A tiny but valid JPEG header is enough: the API only streams bytes. */
export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xd9]);
export const FAKE_SEGMENT = Buffer.from('G-fake-mpeg-ts-segment');
export const FAKE_ORIGINAL = Buffer.from('original-file-bytes');

export interface TestUser {
  accessToken: string;
  user: { id: string; email: string; role: Role; name: string };
}

/**
 * Creates a user directly in the database and signs an access token exactly
 * like AuthService does. (Registering through the API would hit its 10/min
 * rate limit, since these suites create many users.)
 */
export async function createUser(
  app: NestExpressApplication,
  role: Role,
  opts: { name?: string; organization?: string; channelStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' } = {},
): Promise<TestUser> {
  const [user] = await db(app)
    .insert(users)
    .values({
      email: `${role.toLowerCase()}-${randomUUID()}@test.local`,
      name: opts.name ?? `Test ${role}`,
      role,
      passwordHash: 'not-used-in-these-tests',
    })
    .returning({ id: users.id, email: users.email, role: users.role, name: users.name });
  if (role === 'UPLOADER') await db(app).insert(uploaderProfiles).values({ userId: user.id });
  if (role === 'CHANNEL') {
    await db(app)
      .insert(channelProfiles)
      .values({
        userId: user.id,
        organization: opts.organization ?? 'Test News',
        status: opts.channelStatus ?? 'PENDING',
      });
  }
  return { accessToken: await accessTokenFor(app, user), user };
}

export async function accessTokenFor(
  app: NestExpressApplication,
  user: { id: string; email: string; role: Role },
  expiresInSec?: number,
): Promise<string> {
  const config = app.get(AppConfig);
  const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };
  return app
    .get(JwtService)
    .signAsync(payload, { secret: config.jwtAccessSecret, expiresIn: expiresInSec ?? config.jwtAccessTtlSec });
}

/** A CHANNEL user whose organisation an admin has approved. */
export function approvedChannel(app: NestExpressApplication, organization = 'Kerala News 24') {
  return createUser(app, 'CHANNEL', { organization, channelStatus: 'APPROVED' });
}

export async function insertIncident(app: NestExpressApplication, values: Partial<IncidentInsert> = {}) {
  const now = new Date();
  const [row] = await db(app)
    .insert(incidents)
    .values({
      title: 'Fire near Marine Drive',
      category: 'FIRE',
      geohash: 't9y3r2',
      latitude: KOCHI.lat,
      longitude: KOCHI.lng,
      firstSeenAt: now,
      lastSeenAt: now,
      mediaCount: 1,
      uploaderCount: 1,
      ...values,
    })
    .returning();
  return row;
}

/**
 * Inserts a processed media row (APPROVED video by default) with a LOW-risk
 * verification, and writes its preview files, thumbnail and original to storage.
 */
export async function insertMedia(
  app: NestExpressApplication,
  uploaderId: string,
  values: Partial<MediaInsert> = {},
  opts: { withPreview?: boolean } = {},
) {
  const id = randomUUID();
  const type = values.type ?? 'VIDEO';
  const withPreview = opts.withPreview ?? true;
  const ext = type === 'VIDEO' ? '.mp4' : '.jpg';
  const now = new Date();

  const [row] = await db(app)
    .insert(media)
    .values({
      id,
      uploaderId,
      type,
      status: 'APPROVED',
      title: 'Building fire at Marine Drive',
      description: 'Smoke visible from the walkway',
      category: 'FIRE',
      latitude: KOCHI.lat,
      longitude: KOCHI.lng,
      geohash: 't9y3r2',
      locationName: 'Marine Drive, Kochi',
      capturedAt: new Date(now.getTime() - 30 * 60 * 1000),
      originalKey: storageKeys.original(id, ext),
      originalName: `IMG_0001${ext}`,
      mimeType: type === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
      sizeBytes: FAKE_ORIGINAL.length,
      checksum: randomBytes(32).toString('hex'),
      durationSec: type === 'VIDEO' ? 42 : null,
      width: 1920,
      height: 1080,
      previewKey: withPreview ? (type === 'VIDEO' ? storageKeys.hlsDir(id) : storageKeys.previewImage(id)) : null,
      thumbKey: withPreview ? storageKeys.thumbnail(id) : null,
      hlsKeyHex: withPreview && type === 'VIDEO' ? randomBytes(16).toString('hex') : null,
      priceNonExclusive: 500_00,
      priceExclusive: 2500_00,
      reviewedAt: now,
      ...values,
    })
    .returning();

  await db(app)
    .insert(verifications)
    .values({
      mediaId: id,
      aiScore: 0.08,
      aiModel: 'test-model',
      framesScored: 8,
      c2paStatus: 'absent',
      metadata: { device: 'Pixel 8', gps: [KOCHI.lat, KOCHI.lng] },
      signals: [{ code: 'AI_SCORE_LOW', level: 'positive', message: 'Low AI likelihood' }],
      riskLevel: 'LOW',
    });

  await writeStorageFiles(app, row, withPreview);
  createdMediaIds.add(id);
  return row;
}

/** Ids of media whose files this test run wrote, so they can be deleted afterwards. */
const createdMediaIds = new Set<string>();

/**
 * Deletes the storage files written by `insertMedia`. Call in afterAll.
 * Only our own keys are deleted: other test files may share the storage folder.
 * (It also keeps fake "seg_000.ts" files from being picked up by `tsc`.)
 */
export async function cleanupStorage(app: NestExpressApplication) {
  const storage = app.get(StorageService);
  for (const id of createdMediaIds) {
    await storage.deletePrefix(storageKeys.previewPrefix(id));
    await storage.deletePrefix(`originals/${id}`);
  }
  createdMediaIds.clear();
}

async function writeStorageFiles(app: NestExpressApplication, row: typeof media.$inferSelect, withPreview: boolean) {
  const storage = app.get(StorageService);
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-market-'));
  const put = async (key: string, body: Buffer | string, type: string) => {
    const file = path.join(dir, path.basename(key));
    await writeFile(file, body);
    await storage.putFile(key, file, type);
  };
  try {
    await put(row.originalKey, FAKE_ORIGINAL, row.mimeType);
    if (!withPreview) return;
    await put(storageKeys.thumbnail(row.id), FAKE_JPEG, 'image/jpeg');
    if (row.type === 'PHOTO') {
      await put(storageKeys.previewImage(row.id), FAKE_JPEG, 'image/jpeg');
      return;
    }
    // The worker writes the key URI as a placeholder; the API rewrites it to "key.bin".
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXTINF:4.0,',
      'seg_000.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    await put(storageKeys.hlsPlaylist(row.id), playlist, 'application/vnd.apple.mpegurl');
    await put(`${storageKeys.hlsDir(row.id)}/seg_000.ts`, FAKE_SEGMENT, 'video/mp2t');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Inserts an order directly (the payment flow belongs to the orders module). */
export async function insertOrder(
  app: NestExpressApplication,
  buyerId: string,
  mediaId: string,
  values: Partial<typeof orders.$inferInsert> = {},
) {
  const [row] = await db(app)
    .insert(orders)
    .values({
      buyerId,
      mediaId,
      licenseType: 'NON_EXCLUSIVE',
      amount: 500_00,
      platformFee: 150_00,
      uploaderShare: 350_00,
      status: 'PAID',
      provider: 'mock',
      providerOrderId: `mock_${randomUUID()}`,
      paidAt: new Date(),
      ...values,
    })
    .returning();
  return row;
}

/** The path part of an absolute API URL, for supertest (e.g. "/api/v1/stream/<token>/index.m3u8"). */
export function pathOf(url: string): string {
  return new URL(url).pathname;
}
