import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * The public OCSO website: one landing page plus POST /api/demo-request, served by the Next standalone server
 * (Dockerfile target `website`, infra/compose/website.yaml). Images are served as they are: the screenshots are
 * already sized WebP, so there is no optimizer, no sharp and no writable image cache in the read-only container.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  // The monorepo root, so the standalone trace finds the hoisted pnpm store.
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Don't let `next dev` write AGENTS.md / CLAUDE.md into the app.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
