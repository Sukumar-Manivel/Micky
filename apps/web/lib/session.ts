// The browser-side session: who is logged in and their short-lived access token.
//
// Where things live, and why:
// - The ACCESS token (15 min) is kept only in this module's memory. It is never written to
//   localStorage, so a script injected by an XSS bug cannot read it out of storage later, and
//   it disappears when the tab closes.
// - The REFRESH token (7 days) is an httpOnly cookie set by the API. JavaScript cannot read it
//   at all; the browser simply attaches it to POST /auth/refresh when we ask with
//   `credentials: 'include'`.
//
// "Single-flight" refresh: if five requests all get 401 at the same moment, we must send ONE
// refresh request, not five. The API rotates the refresh token on every use and treats reuse
// of an old one as theft (it revokes every session of that user). Five parallel refreshes would
// therefore log the user out. So the first caller starts the refresh and everyone else awaits
// the same promise.

import type { AuthResponse, UserView } from './types';

export type { AuthResponse };

export interface SessionState {
  user: UserView | null;
  accessToken: string | null;
  /** False until the first refresh attempt on page load has finished. */
  ready: boolean;
}

type Listener = (state: SessionState) => void;
/** Calls POST /auth/refresh; resolves to null when there is no valid session (401). */
export type RefreshFn = () => Promise<AuthResponse | null>;

export function createSessionStore(refreshFn: RefreshFn) {
  let state: SessionState = { user: null, accessToken: null, ready: false };
  let inFlight: Promise<string | null> | null = null;
  const listeners = new Set<Listener>();

  function set(next: Partial<SessionState>) {
    state = { ...state, ...next };
    listeners.forEach((l) => l(state));
  }

  function refresh(): Promise<string | null> {
    if (!inFlight) {
      inFlight = withCrossTabLock(refreshFn)
        .then((res) => {
          if (res) set({ user: res.user, accessToken: res.accessToken, ready: true });
          else set({ user: null, accessToken: null, ready: true });
          return res?.accessToken ?? null;
        })
        .catch(() => {
          // Network error: keep whatever we had, but mark the app as ready so it can render.
          set({ ready: true });
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return {
    getState: () => state,
    getToken: () => state.accessToken,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** After login/register. */
    setAuth(res: AuthResponse) {
      set({ user: res.user, accessToken: res.accessToken, ready: true });
    },
    setUser(user: UserView) {
      set({ user });
    },
    clear() {
      set({ user: null, accessToken: null, ready: true });
    },
    refresh,
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * Two open tabs share one refresh cookie. If both refreshed at the same instant, one would
 * send an already-rotated token and trigger reuse detection. The Web Locks API (supported in
 * all modern browsers) lets tabs queue up: the second tab waits, then sends the new cookie.
 */
function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    // The lock is held until `fn`'s promise settles, then released for the next tab.
    return navigator.locks.request('micky-refresh', fn) as Promise<T>;
  }
  return fn();
}
