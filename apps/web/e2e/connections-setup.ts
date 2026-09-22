import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';

/** Shared seeding for the Connections & models specs (real API, idempotent). */
const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const DEMO_PORT = Number(process.env['E2E_MCP_DEMO_PORT'] ?? E2E.apiPort + 7);
export const DEMO_TOKEN = 'e2e-meridian-demo-token-0123456789';
export const FAKE_KEY = 'sk-e2e-not-a-real-key-0123456789';
export const USERS = {
  exec: { name: 'Cora Exec', email: 'cora.exec@e2e.ocso.test', password: 'correct-horse-battery-cexec', role: 'CS_EXEC' },
  lead: { name: 'Lina Lead', email: 'lina.lead@e2e.ocso.test', password: 'correct-horse-battery-clead', role: 'CS_LEAD' },
} as const;

let demo: ChildProcess | null = null;

export async function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function apiLogin(email: string, password: string): Promise<string> {
  const res = await call('POST', '/v1/auth/login', { email, password });
  expect(res.status, `login ${email}`).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function startDemo(): Promise<void> {
  const main = `${repo}examples/mcp-bank-demo/dist/main.js`;
  if (!existsSync(main)) execFileSync('npx', ['turbo', 'run', 'build', '--filter=@ocso-examples/mcp-bank-demo'], { cwd: repo, stdio: 'ignore' });
  demo = spawn(process.execPath, [main], { env: { ...process.env, PORT: String(DEMO_PORT), HOST: '127.0.0.1', DEMO_MCP_AUTH: 'bearer', DEMO_MCP_TOKEN: DEMO_TOKEN }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`http://127.0.0.1:${DEMO_PORT}/healthz`).then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('example MCP server did not start');
}

/** Setup, users, egress allowlist and (optionally) the example MCP server. */
export function seedConnectionsStack(options: { mcpDemo: boolean }): void {
  test.beforeAll(async () => {
    const status = (await (await call('GET', '/v1/setup/status')).json()) as { setupRequired: boolean };
    if (status.setupRequired) {
      const res = await call('POST', '/v1/setup', { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password });
      expect(res.status).toBe(201);
    }
    const admin = await apiLogin(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
    for (const u of Object.values(USERS)) {
      const res = await call('POST', '/v1/users', { name: u.name, email: u.email, role: u.role, password: u.password }, admin);
      expect([201, 409]).toContain(res.status);
    }
    // The example server runs on loopback: a private address the SSRF guard refuses unless allowlisted (ADR-021).
    expect((await call('PATCH', '/v1/settings/deployment', { egressAllowedInternalHosts: ['127.0.0.1'] }, admin)).status).toBe(200);
    const kinds = (await (await call('GET', '/v1/model-providers/kinds', undefined, admin)).json()) as Array<{ kind: string }>;
    if (!kinds.some((k) => k.kind === 'DEV_SCRIPTED')) throw new Error('Run the API with OCSO_ENABLE_DEV_PROVIDERS=true (DEV_SCRIPTED kind missing)');
    if (options.mcpDemo) await startDemo();
  });
  test.afterAll(() => {
    demo?.kill('SIGTERM');
    demo = null;
  });
}

