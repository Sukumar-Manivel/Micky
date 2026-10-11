// Where the browser finds the API.
//
// Two ways to set it, so one Docker image can run in several environments:
// 1. Runtime (preferred for Docker): set `PUBLIC_API_URL` on the web container. The route
//    `app/runtime-config.js/route.ts` turns it into a tiny script that sets
//    `window.__MICKY_CONFIG__`, and the root layout loads that script before the app's
//    own JavaScript runs.
// 2. Build time: `NEXT_PUBLIC_API_URL`, which Next.js inlines into the browser bundle during
//    `next build`. Used when the runtime value is missing, and in `next dev`.
//
// Either way this is only the address of the API, never a secret: everything here is public.

export interface RuntimeConfig {
  apiUrl?: string;
}

declare global {
  interface Window {
    __MICKY_CONFIG__?: RuntimeConfig;
  }
}

const DEFAULT_API_URL = 'http://localhost:4000';

/** Accepts only absolute http(s) URLs and drops a trailing slash. */
export function normaliseApiUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(trimmed) ? trimmed : null;
}

/** The API origin, e.g. `https://api.micky.in`. Read on every call, so it is never stale. */
export function apiUrl(): string {
  const runtime = typeof window !== 'undefined' ? window.__MICKY_CONFIG__?.apiUrl : undefined;
  return normaliseApiUrl(runtime) ?? normaliseApiUrl(process.env.NEXT_PUBLIC_API_URL) ?? DEFAULT_API_URL;
}

/** The versioned REST base, e.g. `https://api.micky.in/api/v1`. */
export function apiBase(): string {
  return `${apiUrl()}/api/v1`;
}
