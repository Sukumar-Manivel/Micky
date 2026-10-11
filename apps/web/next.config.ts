import type { NextConfig } from "next";

// Response headers for every page. The API sets its own; these cover the web app's HTML.
// The Content-Security-Policy is NOT here: it names the API origin, which is only known at
// runtime (PUBLIC_API_URL), while these headers are frozen at build time. proxy.ts adds it per
// request (lib/csp.ts builds it). X-Frame-Options stays for old browsers without frame-ancestors.
const securityHeaders = [
  // Do not let other sites put FirstFrame in a frame (clickjacking on "Buy licence").
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Geolocation is used by the upload form and "Near me"; camera and microphone are not.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
];

const nextConfig: NextConfig = {
  // `next build` writes a self-contained server to .next/standalone (server.js plus only the
  // node_modules it needs), which keeps the Docker image small. Copy `public/` and
  // `.next/static/` next to it; see apps/web/.env.example.
  output: "standalone",
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
