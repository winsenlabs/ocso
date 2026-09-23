import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout } from './helpers';

/**
 * The exception report (PM/research/11 §7) against the real API and worker:
 * once setup is complete the worker's leader freezes last week's report; a Head
 * reads the live view, opens the weekly report, signs it and downloads the
 * signed export (verified here as VERIFY.txt says); a report naming the Head
 * is signed only as self-attested; the Tech admin sees their scoped view and
 * the Storage panel.
 *   E2E_API_PORT=4504 E2E_WEB_PORT=3504 npx playwright test e2e/exceptions.spec.ts
 */
test.describe.configure({ mode: 'serial' });

const HEAD = { name: 'Esme Signer', email: 'exc.head@e2e.ocso.test', password: 'correct-horse-battery-exchead' };

let api: APIRequestContext;
const tok = { admin: '', head: '' };
let reportId = '';

/** The export is a stored (uncompressed) zip: read its local file entries. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extra = zip.readUInt16LE(at + 28);
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    out.set(name, zip.subarray(start, start + size));
    at = start + size;
  }
  return out;
}
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(180_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  // The e2e stack skips access approvals (development flag): creating this Head is itself an exception.
  await call('POST', '/v1/users', tok.admin, { name: HEAD.name, email: HEAD.email, role: 'HEAD', password: HEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.head = await loginApi(HEAD.email, HEAD.password);
  // The leader task (every minute) freezes last week's report once setup is complete.
  await expect
    .poll(async () => (await call<{ rows: Array<{ id: string; kind: string; status: string }> }>('GET', '/v1/exceptions/reports?limit=10', tok.head)).rows.find((r) => r.kind === 'WEEKLY')?.id ?? '', {
      timeout: 150_000,
      intervals: [2000],
    })
    .not.toBe('');
  const rows = (await call<{ rows: Array<{ id: string; kind: string; status: string }> }>('GET', '/v1/exceptions/reports?limit=10', tok.head)).rows;
  reportId = rows.find((r) => r.kind === 'WEEKLY' && r.status === 'DRAFT')?.id ?? rows.find((r) => r.kind === 'WEEKLY')!.id;
});

test.afterAll(async () => {
  await api?.dispose();
});

test('a Head reads the live view: skipped approvals are listed, clean checks summarised', async ({ page }) => {
  await login(page, HEAD);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Exceptions' }).click();
  await expect(page).toHaveURL(/\/exceptions$/);
  await expect(page.getByRole('heading', { name: 'Exceptions', level: 1 })).toBeVisible();
  const bypass = page.getByRole('region', { name: 'Permissions granted without approval' });
  await expect(bypass).toBeVisible();
  await expect(bypass).toContainText('Approval skipped (development flag)');
  await expect(page.getByRole('region', { name: 'Checks with nothing to report' })).toBeVisible();
  await expect(page.getByText('Your teams’ view')).toHaveCount(0);
});

test('a Head opens the weekly report, signs it and downloads the signed export', async ({ page }) => {
  await login(page, HEAD);
  await page.goto('/exceptions');
  await page.getByRole('tab', { name: 'Weekly reports' }).click();
  const table = page.getByRole('table', { name: 'Exception reports' });
  await expect(table).toBeVisible();
  await page.goto(`/exceptions/reports/${reportId}`);
  const report = page.getByRole('region', { name: 'Report summary' });
  await expect(report.getByRole('heading', { name: 'Weekly report' })).toBeVisible();
  await expect(report).toContainText('awaiting signature');
  // Frozen only after setup: cut in the time zone setup chose.
  await expect(report).toContainText('(Asia/Kolkata)');
  const form = page.getByRole('form', { name: 'Sign this report' });
  await form.getByLabel('Note (optional)').fill('Reviewed with the risk committee');
  await form.getByRole('button', { name: 'Sign report' }).click();
  // The action revalidates the page: the form gives way to the signed report.
  await expect(report).toContainText('signature verifies', { timeout: 15_000 });
  await page.reload();
  await expect(report).toContainText('signature verifies');
  await expect(report).toContainText(HEAD.name);
  await expect(report).toContainText('Reviewed with the risk committee');
  await expect(page.getByRole('form', { name: 'Sign this report' })).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent('download'), report.getByRole('link', { name: 'Download signed export' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^ocso-exceptions-weekly-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const files = unzip(await readFile(path));
  expect([...files.keys()].sort()).toEqual(['VERIFY.txt', 'items.csv', 'manifest.json', 'public-key.pem', 'report.json', 'signature.bin', 'signed-message.txt']);
  // VERIFY.txt's steps: the content hash, the signed message, the Ed25519 signature, the key pinned from the deployment.
  const manifest = JSON.parse(files.get('manifest.json')!.toString()) as { report: { contentHash: string; signNote: string | null; keyId: string } };
  const message = files.get('signed-message.txt')!;
  const lines = message.toString().split('\n');
  expect(sha256(files.get('report.json')!)).toBe(manifest.report.contentHash);
  expect(lines[3]).toBe(manifest.report.contentHash);
  expect(lines[7]).toBe(`note-sha256:${sha256('Reviewed with the risk committee')}`);
  const pem = files.get('public-key.pem')!.toString();
  expect(verify(null, message, createPublicKey(pem), files.get('signature.bin')!)).toBe(true);
  const keys = await call<Array<{ keyId: string; publicKeyPem: string }>>('GET', '/v1/audit/keys', tok.admin);
  expect(keys.find((k) => k.keyId === manifest.report.keyId)?.publicKeyPem).toBe(pem);

  // The report list shows who signed.
  await page.goto('/exceptions?view=reports');
  await expect(page.getByRole('table', { name: 'Exception reports' })).toContainText(HEAD.name);
  await logout(page);
});

test('a report naming the signer can only be signed as self-attested', async ({ page }) => {
  // The Head's own account was created with the approval skipped: a report covering that moment names her.
  const adhoc = await call<{ id: string; attestationRequired: string[] }>('POST', '/v1/exceptions/reports', tok.head, {
    periodStart: new Date(Date.now() - 3_600_000).toISOString(),
    periodEnd: new Date().toISOString(),
  });
  expect(adhoc.attestationRequired).toContain('self_attested');
  await login(page, HEAD);
  await page.goto(`/exceptions/reports/${adhoc.id}`);
  const form = page.getByRole('form', { name: 'Sign this report' });
  const sign = form.getByRole('button', { name: 'Sign report' });
  await expect(form.getByRole('group', { name: 'This sign-off attests' })).toBeVisible();
  await expect(sign).toBeDisabled();
  for (const box of await form.getByRole('checkbox').all()) await box.check();
  await expect(sign).toBeEnabled();
  await sign.click();
  const report = page.getByRole('region', { name: 'Report summary' });
  await expect(report).toContainText('self-attested', { timeout: 15_000 });
  await expect(report).toContainText('signature verifies');
  await logout(page);
});

test('Tech reads a scoped view without signing, and sees the Storage panel on the System screen', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/exceptions');
  await expect(page.getByText('Your teams’ view')).toBeVisible();
  await page.goto(`/exceptions/reports/${reportId}`);
  await expect(page.getByRole('region', { name: 'Report summary' })).toContainText('signed');
  await expect(page.getByRole('link', { name: 'Download signed export' })).toHaveCount(0);
  await page.goto('/system');
  const storage = page.getByRole('region', { name: 'Storage' });
  await expect(storage).toBeVisible();
  await expect(storage).toContainText('Main database');
  await expect(storage.getByRole('table', { name: 'Largest tables' })).toBeVisible();
});
