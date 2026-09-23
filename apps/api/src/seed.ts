/**
 * Meridian Bank demo seed (Compose `seed` service / `pnpm --filter @ocso/api seed`).
 *
 *   OCSO_DEMO_SEED=true node dist/seed.js
 *
 * Does nothing unless OCSO_DEMO_SEED=true. Idempotent: a completed seed leaves
 * an audit marker and later runs exit immediately. Requires a migrated
 * database and the normal API configuration (DATABASE_URL, secrets, blob
 * settings) plus OCSO_ENABLE_DEV_PROVIDERS=true for the scripted model.
 * Exit codes: 0 done / skipped, 1 failed.
 */
import { createDatabase } from '@ocso/db';
import { loadSeedConfig } from './seed/config.js';
import { createSeedContext } from './seed/context.js';
import { printLogins, runDemoSeed } from './seed/run.js';

async function main(): Promise<number> {
  const config = loadSeedConfig();
  if (!config) {
    console.log('seed: OCSO_DEMO_SEED is not "true" — nothing to do');
    return 0;
  }
  const database = createDatabase({
    connectionString: config.api.DATABASE_URL,
    maxConnections: 4,
    applicationName: 'ocso-demo-seed',
    ssl: config.api.DATABASE_SSL,
  });
  try {
    const ctx = createSeedContext(database, config);
    try {
      const outcome = await runDemoSeed(ctx);
      printLogins(ctx, outcome);
      return 0;
    } finally {
      await ctx.auditStore.close();
    }
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Domain errors carry a safe message; never dump config (it holds secrets).
    console.error(`seed: failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
