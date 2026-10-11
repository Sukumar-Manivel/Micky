// Content-Security-Policy for the web app. docs/REVIEW.md L10.
//
// Built per request by `proxy.ts`, because the API's address is only known at runtime
// (PUBLIC_API_URL on the container, the same value /runtime-config.js serves). next.config.ts
// headers are frozen at build time, so they cannot carry it.
//
// What each source is for:
// - script-src 'self' + Razorpay Checkout's script. 'unsafe-inline' is needed because Next.js
//   streams its page data as inline <script> tags; nonces would fix that but force every page to
//   render per request and are incompatible with Partial Prerendering (cacheComponents), which
//   this app uses. The real protection comes from everything else here: no other script hosts,
//   no plugins, no <base> hijack, no framing, and connections only to our own API.
// - style-src 'unsafe-inline': Leaflet and React set inline style attributes.
// - img-src: our API (thumbnails, photo previews), OpenStreetMap tiles, Razorpay's logos,
//   data:/blob: (Leaflet, video posters).
// - media-src / worker-src blob:: hls.js plays the encrypted preview through MediaSource
//   (a blob: URL) and runs its demuxer in a blob: Web Worker.
// - connect-src: the API (REST + hls.js segment/key fetches) and its ws(s):// twin for
//   Socket.IO; Razorpay for its checkout telemetry.
// - frame-src: Razorpay Checkout opens in an iframe from api.razorpay.com.
// - frame-ancestors 'none': nobody may frame Micky (clickjacking on "Buy licence").

export const RAZORPAY = {
  script: 'https://checkout.razorpay.com',
  frames: ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  other: 'https://*.razorpay.com',
} as const;

export const OSM_TILES = 'https://tile.openstreetmap.org';

export interface CspOptions {
  /** API origin, e.g. https://api.micky.in. Anything after the origin is ignored. */
  apiUrl: string;
  /** `next dev` needs eval (React's error overlay) and the HMR websocket. */
  dev?: boolean;
}

/** The API's origin and its websocket twin, or nothing if the URL is not http(s). */
export function apiSources(apiUrl: string): { http: string; ws: string } | null {
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { http: url.origin, ws: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
  } catch {
    return null;
  }
}

export function buildCsp({ apiUrl, dev = false }: CspOptions): string {
  const api = apiSources(apiUrl);
  const apiHttp = api ? [api.http] : [];
  const apiWs = api ? [api.ws] : [];
  const httpsOnly = !dev && api?.http.startsWith('https://');

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", RAZORPAY.script, ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', ...apiHttp, OSM_TILES, RAZORPAY.other],
    'font-src': ["'self'", 'data:'],
    'media-src': ["'self'", 'blob:', ...apiHttp],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", ...apiHttp, ...apiWs, RAZORPAY.other, ...(dev ? ['ws:'] : [])],
    'frame-src': [...RAZORPAY.frames],
    'frame-ancestors': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'manifest-src': ["'self'"],
  };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  // Only when the API is on HTTPS: locally (http://localhost:4000) it would break every call.
  if (httpsOnly) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}
