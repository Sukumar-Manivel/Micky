import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { auth, registerUser, resetDb, startApp } from './helpers.js';
import { clearRateLimits } from './orders.fixtures.js';

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
    clearRateLimits(app);
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
