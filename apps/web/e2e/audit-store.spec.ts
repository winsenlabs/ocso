import { expect, test } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, settled } from './helpers';

/**
 * The audit store on the System screen (ADR-032) against the real API and
 * worker: the worker leader ships the outbox, seals the chain and signs a
 * checkpoint; the Tech admin sees it and verifies the latest entries.
 *   E2E_API_PORT=4494 E2E_WEB_PORT=3494 npx playwright test e2e/audit-store.spec.ts
 */
test.describe.configure({ mode: 'serial' });

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let token = '';

test.beforeAll(async () => {
  const status = (await (await call('GET', '/v1/setup/status')).json()) as { setupRequired: boolean };
  if (status.setupRequired) {
    const res = await call('POST', '/v1/setup', {
      setupToken: E2E.setupToken,
      orgName: 'E2E Bank',
      adminName: ACCOUNTS.admin.name,
      adminEmail: ACCOUNTS.admin.email,
      adminPassword: ACCOUNTS.admin.password,
    });
    expect(res.status).toBe(201);
  }
  token = ((await (await call('POST', '/v1/auth/login', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password })).json()) as { token: string }).token;
});

test('the worker ships and seals audit events; the API reads them from the store', async () => {
  await expect
    .poll(async () => ((await (await call('GET', '/v1/audit/store', undefined, token)).json()) as { unshipped: number; lastCheckpoint: unknown }), { timeout: 45_000, intervals: [1000] })
    .toMatchObject({ unshipped: 0, lastCheckpoint: expect.objectContaining({ upToPosition: expect.any(Number) }) });
  const res = await call('GET', '/v1/audit?limit=20', undefined, token);
  expect(res.headers.get('x-ocso-audit-source')).toBe('store');
  expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  const keys = (await (await call('GET', '/v1/audit/keys', undefined, token)).json()) as Array<{ algorithm: string }>;
  expect(keys).toEqual([expect.objectContaining({ algorithm: 'Ed25519' })]);
});

test('Tech admin sees the audit store panel and verifies the latest entries', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/system');
  await settled(page);
  const panel = page.getByRole('region', { name: 'Audit store' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('postgres');
  await expect(panel).toContainText(/chain position \d+/);
  await expect(panel).toContainText(/#\d+ · .* · key [0-9a-f]{16}/);
  // The daily full-chain check is reported (not run yet, or its result); the api reads as the reader, so no access warning.
  await expect(panel).toContainText(/Full check\s*(not run yet|passed)/);
  await expect(panel).not.toContainText('Audit store access');
  await panel.getByRole('button', { name: 'Verify recent entries' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Verified' })).toContainText(/Verified #1–\d+: \d+ entries, \d+ signed checkpoints?, no problems/, { timeout: 20_000 });
  // The verification itself is on the record.
  const log = (await (await call('GET', '/v1/audit?action=audit.verify', undefined, token)).json()) as Array<{ action: string }>;
  expect(log[0]?.action).toBe('audit.verify');
});

test('the audit screen reads the store: the verification appears, filters, and opens with its detail', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/audit');
  await settled(page);
  const entries = page.getByRole('table', { name: 'Audit entries' });
  await expect(entries).toContainText(/Verified the audit chain 1–\d+/);
  // Served by the store, so no local-copy banner.
  await expect(page.getByText('Showing the local copy only')).toHaveCount(0);
  await page.getByLabel('Target type').selectOption('audit_store');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/targetType=audit_store/);
  await settled(page);
  await expect(entries).not.toContainText('signed in');
  await entries.getByRole('link', { name: /Verified the audit chain/ }).first().click();
  await expect(page.getByRole('dialog', { name: /Verified the audit chain/ })).toContainText('audit.verify');
});
