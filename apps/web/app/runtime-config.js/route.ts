import { connection } from 'next/server';
import { normaliseApiUrl, type RuntimeConfig } from '@/lib/config';

// Serves `/runtime-config.js`: a one-line script that tells the browser where the API is.
//
// Why: NEXT_PUBLIC_* variables are frozen into the bundle by `next build`, so the same Docker
// image could not be pointed at a staging API and a production API. This route reads
// PUBLIC_API_URL when the request arrives, so it can change with a container restart.
// The root layout loads it with a plain (blocking) <script>, so it has run before any of the
// app's JavaScript asks for the API address.
export async function GET() {
  // `connection()` tells Next.js to run this on every request instead of prerendering it at
  // build time, when the container's environment is not known yet.
  await connection();

  const config: RuntimeConfig = {};
  const apiUrl = normaliseApiUrl(process.env.PUBLIC_API_URL) ?? normaliseApiUrl(process.env.NEXT_PUBLIC_API_URL);
  if (apiUrl) config.apiUrl = apiUrl;

  // JSON.stringify plus escaping "<" means the value cannot break out of the script.
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return new Response(`window.__FIRSTFRAME_CONFIG__=${json};\n`, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Short cache: cheap on repeat visits, and a changed URL is picked up within minutes.
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
