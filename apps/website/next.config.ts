import type { NextConfig } from 'next';

/**
 * The public OCSO website: a fully static export (`out/`), served by a small static server
 * (Dockerfile target `website`, infra/compose/website.yaml). No server, no image optimizer.
 */
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: false,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Don't let `next dev` write AGENTS.md / CLAUDE.md into the app.
  agentRules: false,
};

export default nextConfig;
