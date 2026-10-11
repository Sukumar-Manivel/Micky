// Small API client for test setup and for checks the UI cannot show (HTTP status codes).
// The scripted user journeys go through the browser; this is only for arranging state
// quickly (e.g. a second newsroom) and asserting server-side rules.
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, API } from './env.js';

export interface Session {
  token: string;
  user: { id: string; email: string; role: string };
}

export async function call<T = unknown>(
  method: string,
  route: string,
  opts: { token?: string; body?: unknown; form?: FormData } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

async function ok<T>(p: Promise<{ status: number; body: T }>, expected = [200, 201]): Promise<T> {
  const { status, body } = await p;
  expect(expected, `unexpected HTTP ${status}: ${JSON.stringify(body)}`).toContain(status);
  return body;
}

/** Unique per run, so reruns against a kept database never collide. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@micky-e2e.test`;
}

export const PASSWORD = 'correct-horse-battery-staple';

export async function register(
  role: 'UPLOADER' | 'CHANNEL',
  extra: { name?: string; organization?: string; email?: string } = {},
): Promise<Session> {
  const body = await ok(
    call<{ accessToken: string; user: Session['user'] }>('POST', '/auth/register', {
      body: {
        email: extra.email ?? uniqueEmail(role.toLowerCase()),
        password: PASSWORD,
        name: extra.name ?? `E2E ${role}`,
        role,
        ...(role === 'CHANNEL' ? { organization: extra.organization ?? 'E2E Newsroom' } : {}),
      },
    }),
  );
  return { token: body.accessToken, user: body.user };
}

export async function login(email: string, password: string): Promise<Session> {
  const body = await ok(
    call<{ accessToken: string; user: Session['user'] }>('POST', '/auth/login', { body: { email, password } }),
  );
  return { token: body.accessToken, user: body.user };
}

// One admin API session per test worker: the API allows 10 logins per minute per IP, and the
// whole suite runs from one IP. (Access tokens live 15 minutes; the suite takes about one.)
let adminSession: Promise<Session> | undefined;
export const loginAdmin = () => (adminSession ??= login(ADMIN_EMAIL, ADMIN_PASSWORD));

export async function approveChannel(admin: Session, userId: string) {
  await ok(call('POST', `/admin/channels/${userId}/approve`, { token: admin.token }));
}

export async function approveMedia(admin: Session, mediaId: string) {
  await ok(call('POST', `/admin/media/${mediaId}/approve`, { token: admin.token, body: {} }));
}

export async function uploadVideo(uploader: Session, file: string, title: string): Promise<{ id: string }> {
  const form = new FormData();
  form.set('title', title);
  form.set('category', 'FIRE');
  form.set('latitude', '13.0827');
  form.set('longitude', '80.2707');
  form.set('locationName', 'Chennai Central');
  form.set('capturedAt', new Date().toISOString());
  form.set('rightsConfirmed', 'true');
  form.set('file', await openAsBlob(file, { type: 'video/mp4' }), path.basename(file));
  return ok(call<{ id: string }>('POST', '/media', { token: uploader.token, form }), [201]);
}

/** Waits until the worker has moved the upload on (to IN_REVIEW, or FAILED). */
export async function waitForStatus(uploader: Session, mediaId: string, status: string, timeoutMs = 60_000) {
  await expect
    .poll(async () => (await call<{ status: string }>('GET', `/me/media/${mediaId}`, { token: uploader.token })).body.status, {
      timeout: timeoutMs,
      intervals: [500, 1000, 2000],
    })
    .toBe(status);
}
