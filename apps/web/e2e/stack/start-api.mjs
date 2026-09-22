// E2E: create a throwaway database, migrate it, then run the built API in the
// foreground (Playwright's webServer owns the process). Expects the API and
// @ocso/db to be built: `npx turbo run build --filter=@ocso/api...`.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { E2E_DB_NAME: db, E2E_PG_URL: pg, E2E_API_PORT: port, E2E_SETUP_TOKEN: setupToken } = process.env;
if (!db || !pg || !port || !setupToken) throw new Error('start-api: E2E_* env vars missing (run through playwright.config.ts)');
if (!/^[a-z0-9_]+$/.test(db)) throw new Error(`start-api: unsafe database name ${db}`);

const psql = (sql) =>
  execFileSync('psql', [`${pg}/postgres`, '-v', 'ON_ERROR_STOP=1', '-qc', sql], {
    stdio: 'inherit',
    env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' },
  });
psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
psql(`CREATE DATABASE ${db}`);

const databaseUrl = `${pg}/${db}`;
const blobDir = mkdtempSync(join(tmpdir(), 'ocso-web-e2e-blobs-'));
execFileSync(process.execPath, [join(repo, 'packages/db/dist/bin/migrate.js')], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: databaseUrl },
});

const api = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
  cwd: join(repo, 'apps/api'),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    PORT: port,
    DATABASE_URL: databaseUrl,
    OCSO_SETUP_TOKEN: setupToken,
    BLOB_SIGNING_KEY: randomBytes(24).toString('base64url'),
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    BLOB_LOCAL_DIR: blobDir,
    OCSO_PUBLIC_URL: `http://localhost:${process.env.E2E_WEB_PORT ?? 3400}`,
  },
});

// On shutdown: stop the API first, then drop the throwaway database
// (E2E_KEEP_DB=1 keeps it for debugging). The next run recreates it anyway.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    api.kill(signal);
  });
}
api.on('exit', (code) => {
  rmSync(blobDir, { recursive: true, force: true });
  if (stopping && process.env.E2E_KEEP_DB !== '1') {
    try {
      psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    } catch {
      // best effort; the next run drops it before creating
    }
  }
  process.exit(stopping ? 0 : (code ?? 1));
});
