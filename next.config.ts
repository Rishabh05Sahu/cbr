import type { NextConfig } from 'next';

const production = process.env.NODE_ENV === 'production';

// Phase 2 M4: browsers PUT import files straight to the private storage bucket with a signed,
// single-object URL, so that one origin (never a path, key or token) joins connect-src.
const storageOrigin = (() => {
  try {
    return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : '';
  } catch {
    return '';
  }
})();

// Next.js injects inline bootstrap scripts; without nonces, 'unsafe-inline' is required.
// Everything else is same-origin only. Dev mode additionally needs 'unsafe-eval'.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${storageOrigin ? ` ${storageOrigin}` : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(production
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    'pg',
    '@prisma/client',
    '@prisma/adapter-pg',
    'bullmq',
    'ioredis',
    'pino',
    'nodemailer',
  ],
  poweredByHeader: false,
  typedRoutes: true,
  async headers() {
    // Per-user file routes: also covers responses the framework generates itself (for example
    // 405 for another method), which never reach the route's own privateRoute wrapper.
    const privateFile = [{ key: 'Cache-Control', value: 'private, no-store' }];
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/app/leads/exports/:id/download', headers: privateFile },
      { source: '/app/leads/import/:id/issues.csv', headers: privateFile },
    ];
  },
};

export default nextConfig;
