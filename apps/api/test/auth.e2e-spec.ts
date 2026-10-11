import type { NestExpressApplication } from '@nestjs/platform-express';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { Redis } from 'ioredis';
import { RATE_LIMIT_PREFIX, RATE_LIMIT_REDIS } from '../src/auth/rate-limit/redis.provider.js';
import { refreshTokens } from '../src/db/schema.js';
import { auth, clearRateLimits, db, registerUser, resetDb, startApp } from './helpers.js';

describe('Auth (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await startApp();
  });
  beforeEach(async () => {
    await resetDb(app);
  });
  afterAll(async () => {
    await app.close();
  });

  it('registers an uploader and returns an access token and httpOnly refresh cookie', async () => {
    const { accessToken, user, cookie } = await registerUser(app, 'UPLOADER');
    expect(accessToken).toBeTruthy();
    expect(user.role).toBe('UPLOADER');
    expect(user).not.toHaveProperty('passwordHash');
    expect(cookie.join(';')).toMatch(/ff_refresh=.*HttpOnly/i);
  });

  it('registers a channel as PENDING and requires an organisation', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'x@test.local', password: 'correct-horse-battery', name: 'X', role: 'CHANNEL' })
      .expect(400);

    const { user } = await registerUser(app, 'CHANNEL');
    expect((user as unknown as { channel: { status: string } }).channel.status).toBe('PENDING');
  });

  it('does not allow self-registration as ADMIN', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: 'a@test.local', password: 'correct-horse-battery', name: 'A', role: 'ADMIN' })
      .expect(400);
  });

  it('rejects a duplicate email', async () => {
    const { user } = await registerUser(app, 'UPLOADER');
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: user.email, password: 'correct-horse-battery', name: 'Again', role: 'UPLOADER' })
      .expect(409);
  });

  it('answers 409, not 500, when the same email registers twice at the same moment (double submit)', async () => {
    const body = { email: 'double-submit@test.local', password: 'correct-horse-battery', name: 'Twice', role: 'UPLOADER' };
    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => request(app.getHttpServer()).post('/api/v1/auth/register').send(body)),
    );
    // These 4 registrations must not eat the 10/min budget of the tests after this one.
    await clearRateLimits(app);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body.message).toBe('An account with this email already exists');
    }
  });

  it('logs in with the right password and rejects the wrong one with the same message', async () => {
    const { user, password } = await registerUser(app, 'UPLOADER');
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password })
      .expect(200);

    const wrong = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'wrong-password' })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'wrong-password' })
      .expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('protects /auth/me and returns the current user with a valid token', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    const { accessToken, user } = await registerUser(app, 'UPLOADER');
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(accessToken)).expect(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('rotates refresh tokens and revokes all sessions when an old token is reused', async () => {
    const { cookie } = await registerUser(app, 'UPLOADER');

    const first = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);
    const rotatedCookie = first.headers['set-cookie'] as unknown as string[];
    expect(first.body.accessToken).toBeTruthy();

    // Reusing the original (already rotated) token is treated as theft.
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
    // ...so even the newest token no longer works.
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', rotatedCookie).expect(401);
  });

  it('gives exactly one success when the same refresh token is used twice at the same moment (M1)', async () => {
    const { cookie } = await registerUser(app, 'UPLOADER');
    const server = app.getHttpServer();

    const responses = await Promise.all(
      [1, 2].map(() => request(server).post('/api/v1/auth/refresh').set('Cookie', cookie)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);

    // The loser counts as reuse of a rotated token, so the winner's new session is revoked too:
    // a thief racing the real client cannot keep a session alive.
    const winner = responses.find((r) => r.status === 200)!;
    await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', winner.headers['set-cookie'] as unknown as string[])
      .expect(401);
    const live = await db(app).execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM refresh_tokens WHERE revoked_at IS NULL`,
    );
    expect(live.rows[0].n).toBe(0);
  });

  it('never lets more than one of many parallel refreshes win', async () => {
    const { cookie } = await registerUser(app, 'UPLOADER');
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie)),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 500)).toHaveLength(0);
  });

  it('keeps the session start across rotations and caps expiry at the absolute lifetime', async () => {
    const { cookie, user } = await registerUser(app, 'UPLOADER');
    // Pretend the user logged in 29 days and 23 hours ago (SESSION_MAX_DAYS defaults to 30).
    const started = new Date(Date.now() - (30 * 24 - 1) * 3600_000);
    await db(app).update(refreshTokens).set({ createdAt: started }).where(eq(refreshTokens.userId, user.id));

    const res = await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);
    const live = await db(app).query.refreshTokens.findFirst({
      where: sql`${refreshTokens.userId} = ${user.id} AND ${refreshTokens.revokedAt} IS NULL`,
    });
    expect(live!.createdAt.getTime()).toBe(started.getTime());
    // About one hour left, not another 7 days.
    const left = live!.expiresAt.getTime() - Date.now();
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThan(65 * 60_000);
    expect(String(res.headers['set-cookie'])).toMatch(/Expires=/);
  });

  it('refuses to refresh a session older than the absolute lifetime', async () => {
    const { cookie, user } = await registerUser(app, 'UPLOADER');
    await db(app)
      .update(refreshTokens)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 3600_000) })
      .where(eq(refreshTokens.userId, user.id));
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('backs off per account after repeated failed logins, even with the right password (L2)', async () => {
    const { user, password } = await registerUser(app, 'UPLOADER');
    const server = app.getHttpServer();
    const attempt = (pw: string) => request(server).post('/api/v1/auth/login').send({ email: user.email, password: pw });

    // 5 free failures, then the 6th failure sets a 30 s lock.
    for (let i = 0; i < 6; i += 1) await attempt('wrong-password').expect(401);
    const locked = await attempt(password).expect(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(30);
    expect(locked.body.message).toMatch(/Too many failed attempts/);

    // Once the lock is gone (cleared here instead of waiting), the right password works and resets the count.
    await clearRateLimits(app);
    await attempt(password).expect(200);
  });

  it('treats unknown emails exactly like real ones, so the backoff does not reveal accounts', async () => {
    const attempt = () =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'ghost@test.local', password: 'whatever-pass' });
    for (let i = 0; i < 6; i += 1) await attempt().expect(401);
    await attempt().expect(429);
  });

  it('clears the failure count after a successful login', async () => {
    const { user, password } = await registerUser(app, 'UPLOADER');
    const attempt = (pw: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: user.email, password: pw });
    for (let i = 0; i < 4; i += 1) await attempt('wrong-password').expect(401);
    await attempt(password).expect(200);
    for (let i = 0; i < 4; i += 1) await attempt('wrong-password').expect(401);
    await attempt(password).expect(200);
  });

  it('rejects registration passwords longer than bcrypt can use (72 bytes)', async () => {
    const base = { name: 'Long', role: 'UPLOADER' };
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...base, email: 'long1@test.local', password: 'a'.repeat(73) })
      .expect(400);
    // 25 Tamil letters = 75 bytes in UTF-8: too long, although it is only 25 characters.
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...base, email: 'long2@test.local', password: 'த'.repeat(25) })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toMatch(/72 bytes/);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...base, email: 'long3@test.local', password: 'a'.repeat(72) })
      .expect(201);
  });

  it('shares rate limits through Redis: the 11th login in a minute from one IP gets 429', async () => {
    const server = app.getHttpServer();
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await request(server)
        .post('/api/v1/auth/login')
        .send({ email: `rl${i}@test.local`, password: 'whatever-pass' });
      codes.push(r.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    // The counters are in Redis (shared by every API process), not in this process's memory.
    const keys = await app.get<Redis>(RATE_LIMIT_REDIS).keys(`${RATE_LIMIT_PREFIX}t*:default:*`);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('logout revokes the refresh token', async () => {
    const { cookie } = await registerUser(app, 'UPLOADER');
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('health check reports the database is up', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body.database).toBe('up');
  });
});
