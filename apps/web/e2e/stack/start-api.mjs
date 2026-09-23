// E2E: create a throwaway database, migrate it, then run the built API in the
// foreground (Playwright's webServer owns the process). Expects the API and
// @ocso/db to be built: `npx turbo run build --filter=@ocso/api...`.
// When apps/worker is built too (`--filter=@ocso/worker...`), a worker runs
// beside the API on the same database, blob dir and secrets so AI turns,
// escalations and channel delivery happen (E2E_NO_WORKER=1 skips it). Both
// enable the development-only scripted model provider (ADR-015).
// The audit store (ADR-032) gets its own throwaway database `<db>_audit` on the
// same server, provisioned by the audit-migrate bin with a per-run writer role (the worker)
// and a SELECT-only reader role (the api, as in production),
// and an Ed25519 signing key in a temp file.
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Audit store: its own database and writer role, provisioned as the migrate step does.
const auditDb = `${db}_audit`;
const auditRole = `${db}_audit_w`;
const auditOwnerUrl = `${pg}/${auditDb}`;
const auditWriter = new URL(auditOwnerUrl);
auditWriter.username = auditRole;
auditWriter.password = randomBytes(12).toString('hex');
// The api reads through a SELECT-only reader role, as in production; the worker writes.
const auditReader = new URL(auditOwnerUrl);
auditReader.username = `${db}_audit_r`;
auditReader.password = randomBytes(12).toString('hex');
const auditMigrate = join(repo, 'packages/audit-store/dist/bin/audit-migrate.js');
// api and worker now require an audit store: without the built bin nothing could start, so say exactly what to build.
if (!existsSync(auditMigrate)) {
  throw new Error('start-api: packages/audit-store is not built (dist/bin/audit-migrate.js missing). Run `npx turbo run build --filter=@ocso/api... --filter=@ocso/worker...` first.');
}
const keyDir = mkdtempSync(join(tmpdir(), 'ocso-web-e2e-audit-key-'));
const auditKeyFile = join(keyDir, 'audit_signing_key');
writeFileSync(auditKeyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
psql(`DROP DATABASE IF EXISTS ${auditDb} WITH (FORCE)`);
psql(`CREATE DATABASE ${auditDb}`);
execFileSync(process.execPath, [auditMigrate], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AUDIT_DRIVER: 'postgres',
    AUDIT_DATABASE_OWNER_URL: auditOwnerUrl,
    AUDIT_DATABASE_URL: auditWriter.toString(),
    AUDIT_READER_URL: auditReader.toString(),
  },
});
const auditEnv = { AUDIT_DRIVER: 'postgres', AUDIT_DATABASE_URL: auditWriter.toString(), AUDIT_SIGNING_KEY_FILE: auditKeyFile };

// Shared by API and worker: same DB, blobs, blob-URL signing and secrets master key.
const shared = {
  ...auditEnv,
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  DATABASE_URL: databaseUrl,
  BLOB_SIGNING_KEY: randomBytes(24).toString('base64url'),
  OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
  BLOB_LOCAL_DIR: blobDir,
  OCSO_PUBLIC_URL: `http://localhost:${process.env.E2E_WEB_PORT ?? 3400}`,
  OCSO_ENABLE_DEV_PROVIDERS: 'true',
};

// Authentication (ADR-025): a fixed Better Auth secret, the log email driver with the test-only
// hook that lets specs read invite / reset links (refused in production), and break-glass recovery.
const api = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
  cwd: join(repo, 'apps/api'),
  stdio: 'inherit',
  env: {
    ...process.env,
    ...shared,
    AUDIT_DATABASE_URL: auditReader.toString(),
    PORT: port,
    OCSO_SETUP_TOKEN: setupToken,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    EMAIL_DRIVER: 'log',
    OCSO_ENABLE_TEST_HOOKS: 'true',
    // Specs create working users through the API and UI; approval of access increases is skipped here
    // (development/test only, refused in production). Per-user grants still need approval.
    OCSO_DEV_SKIP_ACCESS_APPROVAL: process.env.E2E_SKIP_ACCESS_APPROVAL ?? 'true',
    OCSO_RECOVERY_TOKEN: process.env.E2E_RECOVERY_TOKEN ?? 'e2e-recovery-token-0123456789-abcdefghij',
  },
});

const workerMain = join(repo, 'apps/worker/dist/main.js');
const worker =
  process.env.E2E_NO_WORKER !== '1' && existsSync(workerMain)
    ? spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
        cwd: join(repo, 'apps/worker'),
        stdio: 'inherit',
        env: { ...process.env, ...shared, HEALTH_PORT: String(Number(port) + 1), WORKER_ID: `e2e-${port}` },
      })
    : null;
if (!worker) console.warn('start-api: no worker (build apps/worker to run AI turns in e2e)');

// On shutdown: stop the API first, then drop the throwaway database
// (E2E_KEEP_DB=1 keeps it for debugging). The next run recreates it anyway.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    worker?.kill(signal);
    api.kill(signal);
  });
}
api.on('exit', (code) => {
  if (worker && worker.exitCode === null) worker.kill('SIGTERM');
  rmSync(blobDir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
  if (stopping && process.env.E2E_KEEP_DB !== '1') {
    try {
      psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      psql(`DROP DATABASE IF EXISTS ${auditDb} WITH (FORCE)`);
      psql(`DROP ROLE IF EXISTS ${auditRole}`);
      psql(`DROP ROLE IF EXISTS ${db}_audit_r`);
    } catch {
      // best effort; the next run drops it before creating
    }
  }
  process.exit(stopping ? 0 : (code ?? 1));
});
