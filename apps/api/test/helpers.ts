// Shared helpers for e2e tests.
import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { DB, type Database } from '../src/db/db.module.js';
import { createApp } from '../src/main.js';

export async function startApp(): Promise<NestExpressApplication> {
  const app = await createApp();
  await app.init();
  return app;
}

/** Empties every table between tests, so each test starts from a clean database. */
export async function resetDb(app: NestExpressApplication) {
  const db = app.get<Database>(DB);
  await db.execute(sql`
    TRUNCATE users, uploader_profiles, channel_profiles, refresh_tokens, incidents, media,
      verifications, orders, payouts, ledger_entries, webhook_events, reports
    RESTART IDENTITY CASCADE`);
}

export function db(app: NestExpressApplication): Database {
  return app.get<Database>(DB);
}

let counter = 0;

/** Registers a user through the real API and returns its access token and cookie. */
export async function registerUser(
  app: NestExpressApplication,
  role: 'UPLOADER' | 'CHANNEL',
  overrides: Record<string, unknown> = {},
) {
  counter += 1;
  const body = {
    email: `${role.toLowerCase()}${counter}-${Date.now()}@test.local`,
    password: 'correct-horse-battery',
    name: `Test ${role}`,
    role,
    ...(role === 'CHANNEL' ? { organization: 'Test News' } : {}),
    ...overrides,
  };
  const res = await request(app.getHttpServer()).post('/api/v1/auth/register').send(body).expect(201);
  return {
    accessToken: res.body.accessToken as string,
    user: res.body.user as { id: string; email: string; role: string },
    cookie: res.headers['set-cookie'] as unknown as string[],
    password: body.password,
  };
}

/** Creates an ADMIN directly in the database (admins cannot self-register) and logs in. */
export async function createAdmin(app: NestExpressApplication) {
  const bcrypt = (await import('bcryptjs')).default;
  const { users } = await import('../src/db/schema.js');
  const email = `admin-${Date.now()}-${++counter}@test.local`;
  await db(app)
    .insert(users)
    .values({ email, name: 'Admin', role: 'ADMIN', passwordHash: await bcrypt.hash('admin-password-123', 4) });
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'admin-password-123' })
    .expect(200);
  return { accessToken: res.body.accessToken as string, user: res.body.user };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
