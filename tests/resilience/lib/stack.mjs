// Local OCSO stack for resilience tests: throwaway database, migrated, with the
// built API and N built workers as real processes (so they can be killed).
// Prerequisite: `npx turbo run build --filter=@ocso/api... --filter=@ocso/worker...`.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PG = (process.env.RES_PG_URL ?? 'postgres://localhost:5432').replace(/\/+$/, '');

const psql = (sql) => execFileSync('psql', [`${PG}/postgres`, '-v', 'ON_ERROR_STOP=1', '-qc', sql], { stdio: 'inherit', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } });

export async function startStack({ dbName = 'ocso_resilience', apiPort = 4490, workers = 2, logLevel = 'warn' } = {}) {
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`unsafe database name ${dbName}`);
  psql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  psql(`CREATE DATABASE ${dbName}`);
  const databaseUrl = `${PG}/${dbName}`;
  execFileSync(process.execPath, [join(repo, 'packages/db/dist/bin/migrate.js')], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: databaseUrl } });
  const blobDir = mkdtempSync(join(tmpdir(), 'ocso-resilience-'));
  const setupToken = randomBytes(18).toString('base64url');
  const shared = {
    NODE_ENV: 'test',
    LOG_LEVEL: logLevel,
    DATABASE_URL: databaseUrl,
    BLOB_SIGNING_KEY: randomBytes(24).toString('base64url'),
    OCSO_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
    BLOB_LOCAL_DIR: blobDir,
    OCSO_PUBLIC_URL: `http://localhost:${apiPort}`,
    OCSO_ENABLE_DEV_PROVIDERS: 'true',
    DATABASE_POOL_SIZE: process.env.RES_DB_POOL ?? '10',
  };
  const procs = new Map();
  const run = (name, cwd, env) => {
    const child = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], { cwd: join(repo, cwd), stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...shared, ...env } });
    procs.set(name, child);
    return child;
  };
  run('api', 'apps/api', { PORT: String(apiPort), OCSO_SETUP_TOKEN: setupToken });
  const startWorker = (i) => run(`worker-${i}`, 'apps/worker', { HEALTH_PORT: String(apiPort + 10 + i), WORKER_ID: `res-worker-${i}` });
  for (let i = 0; i < workers; i++) startWorker(i);
  await waitFor(async () => (await fetch(`http://localhost:${apiPort}/health/ready`).catch(() => null))?.ok, 60_000, 'api ready');
  for (let i = 0; i < workers; i++) await waitFor(async () => (await fetch(`http://localhost:${apiPort + 10 + i}/health/ready`).catch(() => null))?.ok, 60_000, `worker-${i} ready`);

  return {
    baseUrl: `http://localhost:${apiPort}`,
    setupToken,
    databaseUrl,
    startWorker,
    /** SIGKILL = crash (no drain); SIGTERM = graceful shutdown. */
    signal(name, sig) {
      procs.get(name)?.kill(sig);
    },
    /** Resolves with { code, signal } once the process has exited. */
    exited(name) {
      const p = procs.get(name);
      if (!p) return Promise.resolve({ code: null, signal: null });
      if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve({ code: p.exitCode, signal: p.signalCode });
      return new Promise((resolve) => p.once('exit', (code, signal) => resolve({ code, signal })));
    },
    async stop() {
      for (const p of procs.values()) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
      await Promise.all([...procs.values()].map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => p.once('exit', r)))));
      rmSync(blobDir, { recursive: true, force: true });
      psql(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    },
  };
}

export async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}
