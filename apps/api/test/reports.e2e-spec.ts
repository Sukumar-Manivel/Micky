import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { reports } from '../src/db/schema.js';
import { db, resetDb, startApp } from './helpers.js';
import {
  clearRateLimits,
  createUploader,
  insertMedia,
} from './orders.fixtures.js';

describe('Reports (e2e)', () => {
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

  const post = (body: object) =>
    request(server).post('/api/v1/reports').send(body);

  it('accepts a public report about a media item without logging in', async () => {
    const uploader = await createUploader(app);
    const item = await insertMedia(app, uploader.user.id);
    const res = await post({
      mediaId: item.id,
      reporterEmail: ' Owner@Example.COM ',
      reason: 'COPYRIGHT',
      details: 'This is my footage, posted without permission.',
    }).expect(201);
    expect(res.body).toEqual({ id: expect.any(String), status: 'OPEN' });

    const [row] = await db(app)
      .select()
      .from(reports)
      .where(eq(reports.id, res.body.id));
    expect(row).toMatchObject({
      mediaId: item.id,
      reporterEmail: 'owner@example.com',
      reason: 'COPYRIGHT',
    });
  });

  it('accepts a general report without a media id', async () => {
    await post({ reporterEmail: 'a@test.local', reason: 'OTHER' }).expect(201);
  });

  it('validates the body', async () => {
    await post({ reporterEmail: 'not-an-email', reason: 'PRIVACY' }).expect(
      400,
    );
    await post({ reporterEmail: 'a@test.local', reason: 'BORING' }).expect(400);
    await post({
      reporterEmail: 'a@test.local',
      reason: 'FAKE',
      details: 'x'.repeat(2001),
    }).expect(400);
    await post({
      reporterEmail: 'a@test.local',
      reason: 'FAKE',
      mediaId: 'abc',
    }).expect(400);
    await post({
      reporterEmail: 'a@test.local',
      reason: 'FAKE',
      mediaId: '00000000-0000-4000-8000-000000000000',
    }).expect(404);
  });

  it('is rate limited to 5 reports per minute', async () => {
    for (let i = 0; i < 5; i++)
      await post({ reporterEmail: 'spam@test.local', reason: 'OTHER' }).expect(
        201,
      );
    await post({ reporterEmail: 'spam@test.local', reason: 'OTHER' }).expect(
      429,
    );
  });
});
