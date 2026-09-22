import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Server-side API origin (ADR-020). Never exposed to the browser.
 * Note: rewrite destinations are resolved when `next build` runs, so the
 * Compose image must be built with the same API_URL it runs with.
 */
const apiUrl = (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');

/**
 * Public ingress served by the API (ADR-020). On AWS the ALB routes these
 * paths; on Compose Next forwards them. proxy.ts excludes them from the
 * session redirect.
 */
const PUBLIC_INGRESS = ['channels', 'public', 'oauth', '.well-known', 'blobs'] as const;

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  cacheComponents: true,
  reactStrictMode: true,
  poweredByHeader: false,
  // Don't let `next dev` write AGENTS.md / CLAUDE.md into the app.
  agentRules: false,
  async headers() {
    return [
      {
        // Customer web chat embed loader, loaded cross-site by host pages (public/ocso-webchat.js).
        source: '/ocso-webchat.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=300, stale-while-revalidate=3600' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
        ],
      },
    ];
  },
  async redirects() {
    // Templates became a channel capability (ADR-028): old links answer with a real 308 (query string kept).
    return [{ source: '/whatsapp-templates', destination: '/templates', permanent: true }];
  },
  async rewrites() {
    return {
      beforeFiles: PUBLIC_INGRESS.map((prefix) => ({
        source: `/${prefix}/:path*`,
        destination: `${apiUrl}/${prefix}/:path*`,
      })),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
