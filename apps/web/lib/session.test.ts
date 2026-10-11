import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from './session';
import type { AuthResponse } from './types';

const response: AuthResponse = {
  accessToken: 'new-token',
  user: {
    id: 'u1',
    email: 'a@example.com',
    name: 'Asha',
    role: 'UPLOADER',
    createdAt: '2026-10-10T00:00:00.000Z',
    channel: null,
    uploader: { upiId: null },
  },
};

describe('session refresh', () => {
  it('shares one refresh request between concurrent callers (single-flight)', async () => {
    let resolve!: (v: AuthResponse) => void;
    const refreshFn = vi.fn(() => new Promise<AuthResponse>((r) => (resolve = r)));
    const store = createSessionStore(refreshFn);

    const calls = [store.refresh(), store.refresh(), store.refresh()];
    resolve(response);
    const tokens = await Promise.all(calls);

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['new-token', 'new-token', 'new-token']);
    expect(store.getState()).toMatchObject({ accessToken: 'new-token', ready: true });
  });

  it('starts a new refresh after the previous one finished', async () => {
    const refreshFn = vi.fn(async () => response);
    const store = createSessionStore(refreshFn);
    await store.refresh();
    await store.refresh();
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it('clears the session when the refresh cookie is invalid', async () => {
    const store = createSessionStore(async () => null);
    store.setAuth(response);
    expect(await store.refresh()).toBeNull();
    expect(store.getState()).toEqual({ user: null, accessToken: null, ready: true });
  });

  it('notifies subscribers', async () => {
    const store = createSessionStore(async () => response);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.refresh();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new-token' }));
  });
});
