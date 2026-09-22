import { createMeridianApp, type MeridianAuth } from './app.js';

/**
 * Environment:
 *   PORT (default 4100), HOST (default 0.0.0.0)
 *   DEMO_MCP_AUTH = bearer (default) | none
 *   DEMO_MCP_TOKEN        required for bearer mode (>= 16 chars); never logged
 *   DEMO_CLAIMS_SECRET    optional HS256 secret to verify X-OCSO-Customer-Claims
 *   DEMO_ALLOWED_HOSTS    optional comma-separated Host allowlist (DNS-rebinding protection)
 */
function authFromEnv(): MeridianAuth {
  const mode = (process.env.DEMO_MCP_AUTH ?? 'bearer').toLowerCase();
  if (mode === 'none') return { mode: 'none' };
  if (mode !== 'bearer') throw new Error(`Unsupported DEMO_MCP_AUTH "${mode}" (use bearer or none)`);
  const token = process.env.DEMO_MCP_TOKEN;
  if (!token || token.length < 16) throw new Error('DEMO_MCP_TOKEN must be set (at least 16 characters), or set DEMO_MCP_AUTH=none');
  return { mode: 'bearer', token };
}

let auth: MeridianAuth;
try {
  auth = authFromEnv();
} catch (err) {
  console.error(`meridian-core: ${(err as Error).message}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? '0.0.0.0';
const allowedHosts = process.env.DEMO_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
const { app } = createMeridianApp({ auth, claimsSecret: process.env.DEMO_CLAIMS_SECRET, allowedHosts });

const server = app.listen(port, host, () => {
  console.log(`meridian-core MCP server on http://${host}:${port}/mcp (auth: ${auth.mode})`);
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
