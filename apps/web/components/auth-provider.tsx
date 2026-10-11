'use client';

// Exposes the in-memory session (lib/session.ts) to React components.
// `useSyncExternalStore` is React's built-in way to read a store that lives outside React:
// components re-render whenever the store changes, with no tearing between them.

import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { authApi, session } from '@/lib/api';
import type { AuthResponse, SessionState } from '@/lib/session';
import type { UserView } from '@/lib/types';

interface AuthContextValue extends SessionState {
  login: (email: string, password: string) => Promise<UserView>;
  register: (body: Parameters<typeof authApi.register>[0]) => Promise<UserView>;
  logout: () => Promise<void>;
  setUser: (user: UserView) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// On the server there is no session; every page renders its "loading" state.
const serverSnapshot: SessionState = { user: null, accessToken: null, ready: false };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const state = useSyncExternalStore(session.subscribe, session.getState, () => serverSnapshot);

  // On first load, swap the httpOnly refresh cookie (if any) for a fresh access token.
  useEffect(() => {
    if (!session.getState().ready) void session.refresh();
  }, []);

  const finish = (res: AuthResponse) => {
    session.setAuth(res);
    return res.user;
  };

  const value: AuthContextValue = {
    ...state,
    login: async (email, password) => finish(await authApi.login({ email, password })),
    register: async (body) => finish(await authApi.register(body)),
    logout: async () => {
      try {
        await authApi.logout();
      } finally {
        // Even if the network call fails, forget the token locally.
        session.clear();
      }
    },
    setUser: (user) => session.setUser(user),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** For components rendered inside <RequireRole>, where a user is guaranteed. */
export function useSignedInUser(): UserView {
  const { user } = useAuth();
  if (!user) throw new Error('useSignedInUser must be used inside <RequireRole>');
  return user;
}

/** Where each role lands after logging in. */
export function homeFor(user: UserView): string {
  if (user.role === 'ADMIN') return '/admin';
  if (user.role === 'CHANNEL') return '/newsroom';
  return '/dashboard';
}
