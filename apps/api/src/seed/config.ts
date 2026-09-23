import { z } from 'zod';
import { ApiEnv, assertDriverConfig, loadEnv } from '@ocso/config';

/** Documented default demo password (docs/operations/compose.md). Change it with OCSO_DEMO_PASSWORD. */
export const DEFAULT_DEMO_PASSWORD = 'meridian-demo-2026';

const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

/** Seed-only settings; everything else comes from the normal API configuration. */
const SeedEnv = z.object({
  OCSO_DEMO_SEED: flag,
  OCSO_DEMO_PASSWORD: z.string().optional(),
  /** Demo MCP server endpoint (Compose demo profile). Empty = skip the MCP step. */
  MCP_DEMO_URL: z.string().optional(),
  DEMO_MCP_TOKEN: z.string().optional(),
});

export interface SeedConfig {
  enabled: boolean;
  api: ApiEnv;
  password: string;
  /** True when the documented default password is used (it may then be printed). */
  defaultPassword: boolean;
  mcp: { url: string; token: string } | null;
}

/** Returns null when the seed is disabled; throws readable errors for bad settings. */
export function loadSeedConfig(source: NodeJS.ProcessEnv = process.env): SeedConfig | null {
  const seed = SeedEnv.parse(source);
  if (!seed.OCSO_DEMO_SEED) return null;
  const api = loadEnv(ApiEnv, source);
  assertDriverConfig(api);
  if (!api.OCSO_ENABLE_DEV_PROVIDERS) {
    throw new Error('The demo seed uses the development-only scripted model provider: set OCSO_ENABLE_DEV_PROVIDERS=true (ADR-015)');
  }
  const password = seed.OCSO_DEMO_PASSWORD?.trim() || DEFAULT_DEMO_PASSWORD;
  if (password.length < 12) throw new Error('OCSO_DEMO_PASSWORD must be at least 12 characters');
  const url = seed.MCP_DEMO_URL?.trim();
  const token = seed.DEMO_MCP_TOKEN?.trim();
  return {
    enabled: true,
    api,
    password,
    defaultPassword: password === DEFAULT_DEMO_PASSWORD,
    mcp: url && token ? { url, token } : null,
  };
}
