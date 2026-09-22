// E2E: production-build the web app against the e2e API, then serve the
// standalone output (ADR-020 deployment shape) in the foreground.
// Set E2E_REUSE_BUILD=1 to skip `next build` when .next is already current.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { E2E_API_PORT: apiPort, E2E_WEB_PORT: port } = process.env;
if (!apiPort || !port) throw new Error('start-web: E2E_* env vars missing (run through playwright.config.ts)');
const env = { ...process.env, API_URL: `http://localhost:${apiPort}` };

const standalone = join(web, '.next/standalone/apps/web');
if (process.env.E2E_REUSE_BUILD !== '1' || !existsSync(join(standalone, 'server.js'))) {
  execFileSync(join(web, 'node_modules/.bin/next'), ['build'], { cwd: web, stdio: 'inherit', env });
}
cpSync(join(web, '.next/static'), join(standalone, '.next/static'), { recursive: true });
if (existsSync(join(web, 'public'))) cpSync(join(web, 'public'), join(standalone, 'public'), { recursive: true });

const server = spawn(process.execPath, ['server.js'], {
  cwd: standalone,
  stdio: 'inherit',
  env: { ...env, NODE_ENV: 'production', PORT: port, HOSTNAME: 'localhost' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
