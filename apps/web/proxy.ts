// Runs before every page request (Next.js "Proxy", formerly Middleware; Node.js runtime).
// Its only job: attach the Content-Security-Policy, which depends on the API address that the
// container is given at runtime (PUBLIC_API_URL), the same value /runtime-config.js serves.
// See lib/csp.ts for what the policy allows and why.
import { NextResponse } from 'next/server';
import { normaliseApiUrl } from '@/lib/config';
import { buildCsp } from '@/lib/csp';

const DEFAULT_API_URL = 'http://localhost:4000';

let cached: { key: string; value: string } | null = null;

function policy(): string {
  const apiUrl =
    normaliseApiUrl(process.env.PUBLIC_API_URL) ?? normaliseApiUrl(process.env.NEXT_PUBLIC_API_URL) ?? DEFAULT_API_URL;
  const dev = process.env.NODE_ENV === 'development';
  const key = `${apiUrl}|${dev}`;
  if (cached?.key !== key) cached = { key, value: buildCsp({ apiUrl, dev }) };
  return cached.value;
}

export function proxy() {
  const response = NextResponse.next();
  // CSP_REPORT_ONLY=1 sends the policy as report-only: the browser logs violations in the
  // console without blocking anything. Useful for one deploy after changing third parties.
  const header =
    process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  response.headers.set(header, policy());
  return response;
}

export const config = {
  matcher: [
    // Pages and route handlers; not the hashed static files, which are not documents.
    '/((?!_next/static|_next/image|favicon.ico|icons/|fonts/).*)',
  ],
};
