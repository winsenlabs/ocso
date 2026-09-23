import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';

/** Shared seeding for the Connections & models specs (real API, idempotent). */
const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const DEMO_PORT = Number(process.env['E2E_MCP_DEMO_PORT'] ?? E2E.apiPort + 7);
export const DEMO_TOKEN = 'e2e-meridian-demo-token-0123456789';
export const FAKE_KEY = 'sk-e2e-not-a-real-key-0123456789';
export const USERS = {
  exec: { name: 'Cora Exec', email: 'cora.exec@e2e.ocso.test', password: 'correct-horse-battery-cexec', role: 'SERVICE' },
  lead: { name: 'Lina Lead', email: 'lina.lead@e2e.ocso.test', password: 'correct-horse-battery-clead', role: 'HEAD' },
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
    // A settings change is a proposal the Head approves (PM/research/11 §4); skipped when already allowlisted.
    const settings = (await (await call('GET', '/v1/settings/deployment', undefined, admin)).json()) as { egressAllowedInternalHosts: string[] };
    if (!settings.egressAllowedInternalHosts.includes('127.0.0.1')) {
      const lead = await apiLogin(USERS.lead.email, USERS.lead.password);
      const leadId = ((await (await call('GET', '/v1/auth/me', undefined, lead)).json()) as { id: string }).id;
      const res = await call('PATCH', '/v1/settings/deployment', { egressAllowedInternalHosts: [...settings.egressAllowedInternalHosts, '127.0.0.1'], approval: { checkerId: leadId, reason: 'E2E: the example MCP server' } }, admin);
      expect(res.status).toBe(202);
      const { proposal } = (await res.json()) as { proposal: { id: string; contentHash: string } };
      expect((await call('POST', `/v1/approvals/${proposal.id}/decision`, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: proposal.contentHash }, lead)).status).toBe(200);
    }
    const kinds = (await (await call('GET', '/v1/model-providers/kinds', undefined, admin)).json()) as Array<{ kind: string }>;
    if (!kinds.some((k) => k.kind === 'DEV_SCRIPTED')) throw new Error('Run the API with OCSO_ENABLE_DEV_PROVIDERS=true (DEV_SCRIPTED kind missing)');
    if (options.mcpDemo) await startDemo();
  });
  test.afterAll(() => {
    demo?.kill('SIGTERM');
    demo = null;
  });
}


/**
 * Maker–checker in the Connections UI (PM/research/11 §4): the submit-for-approval modal names the Head
 * (Lina Lead) as checker; she approves over the API (the approvals screen has its own spec).
 */
export async function submitForApproval(page: Page, reason = 'E2E: platform change'): Promise<void> {
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(modal).toBeVisible();
  await expect(modal.getByLabel('checker')).toBeVisible();
  await modal.getByLabel('checker').selectOption({ label: USERS.lead.name });
  await modal.getByLabel('reason').fill(reason);
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(modal).toBeHidden();
}

/** Lina approves the open proposal on this object (objectKind + a title fragment); returns its id. */
export async function approveAsLead(objectKind: string, titleIncludes: string): Promise<string> {
  const lead = await apiLogin(USERS.lead.email, USERS.lead.password);
  const res = await call('GET', `/v1/approvals?box=AWAITING_ME&objectKind=${objectKind}`, undefined, lead);
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as { rows: Array<{ id: string; title: string; contentHash: string }> }).rows;
  const open = rows.find((r) => r.title.includes(titleIncludes));
  expect(open, `open ${objectKind} proposal "${titleIncludes}"`).toBeTruthy();
  const decided = await call('POST', `/v1/approvals/${open!.id}/decision`, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: open!.contentHash }, lead);
  expect(decided.status, await decided.clone().text()).toBe(200);
  return open!.id;
}
