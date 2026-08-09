import type { NextConfig } from "next";
import { codeInspectorPlugin } from "code-inspector-plugin";

// Browser -> PocketBase talks to these origins directly (AD-1): the
// realtime SSE subscription (connect-src) and, for DST rows, none — headshots
// come from ESPN/Sleeper CDNs (img-src), matched to src/lib/player-images.ts.
const pocketbaseOrigin = process.env.NEXT_PUBLIC_POCKETBASE_URL || "http://127.0.0.1:8090";

const csp = [
  "default-src 'self'",
  // Next.js hydration/RSC bootstrap needs inline scripts; no nonce plumbing here (ponytail).
  "script-src 'self' 'unsafe-inline'",
  // Radix primitives (popper positioning) set inline style attributes.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: https://a.espncdn.com https://sleepercdn.com`,
  "font-src 'self'",
  `connect-src 'self' ${pocketbaseOrigin} https://site.api.espn.com https://site.web.api.espn.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Content-Security-Policy', value: csp },
  ...(process.env.NODE_ENV === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

// Dev-only: stamps data-insp-path="<file>:<line>:<col>" onto every element so the
// issue-logger extension can report an exact source location. hotKeys is off — we
// only want the attribute, not the plugin's click-to-IDE overlay and its websocket
// (which the CSP above would block anyway). Guarded so `next build` never sees it.
const inspector =
  process.env.NODE_ENV === 'development'
    ? { rules: codeInspectorPlugin({ bundler: 'turbopack', hotKeys: false }) }
    : {};

const nextConfig: NextConfig = {
  // Next 15.3+ moved this out of experimental.turbo.
  turbopack: inspector,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
