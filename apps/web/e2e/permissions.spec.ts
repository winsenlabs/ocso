import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { login } from './helpers';

/**
 * Per-user permissions (PM/research/11 §3.6) through the Team page: a Head
 * opens a teammate's Permissions tab (grouped, with source chips), revokes one
 * permission (a decrease: applies at once) and asks to grant another (an
 * increase: the dialog says it needs approval and the API's approval_required
 * comes back — nothing changes). A mixed change applies its reduction and
 * holds only the increase. A user waiting for approval carries a badge and can
 * be discarded.
 */
test.describe.configure({ mode: 'serial' });

const HEAD = { name: 'Hana Head', email: 'pm.head@e2e.ocso.test', password: 'correct-horse-battery-pmhead' };
const MEMBER = { name: 'Sami Service', email: 'pm.member@e2e.ocso.test', password: 'correct-horse-battery-pmmember' };
const NEWBIE = { name: 'Nia Newcomer', email: 'pm.new@e2e.ocso.test', password: 'correct-horse-battery-pmnew' };

let api: APIRequestContext;
const ids = { member: '', newbie: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (![200, 201, 204].includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;
const person = (who: typeof HEAD, role: string) => ({ name: who.name, email: who.email, role, password: who.password, teamIds: [], languages: [], maxConcurrent: 5 });

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  const admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  // The e2e stack skips access approval (development only), so these colleagues start active.
  await call('POST', '/v1/users', admin, person(HEAD, 'HEAD'));
  ids.member = (await call<{ id: string }>('POST', '/v1/users', admin, person(MEMBER, 'SERVICE'))).id;
  ids.newbie = (await call<{ id: string }>('POST', '/v1/users', admin, person(NEWBIE, 'SERVICE'))).id;
  const head = await loginApi(HEAD.email, HEAD.password);
  const team = await call<{ id: string }>('POST', '/v1/teams', head, { name: 'PM Cards' });
  await call('POST', `/v1/teams/${team.id}/members`, head, { userId: ids.member });
  // A governed deployment creates new users PENDING_APPROVAL; this stack skips that, so mark one by hand.
  execFileSync('psql', [databaseUrl, '-qc', `UPDATE users SET status = 'PENDING_APPROVAL' WHERE id = '${ids.newbie}'`]);
});

test.afterAll(async () => {
  await api?.dispose();
});

const people = (page: Page) => page.getByRole('table', { name: 'People' });

async function openPermissions(page: Page) {
  await page.goto('/team');
  await people(page).getByRole('link', { name: MEMBER.name, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: MEMBER.name });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('tab', { name: 'Permissions' }).click();
  await expect(drawer.getByRole('region', { name: 'Effective permissions' })).toBeVisible();
  return drawer;
}

test('shows a teammate’s effective permissions grouped, with their source', async ({ page }) => {
  await login(page, HEAD);
  const drawer = await openPermissions(page);
  const conversations = drawer.getByRole('list', { name: 'Conversations' });
  const reply = conversations.getByRole('listitem').filter({ hasText: 'Reply to customers' });
  await expect(reply).toContainText('preset');
  await expect(drawer.getByRole('list', { name: 'Platform' }).getByText('Manage secrets')).toHaveCount(0);
});

test('a revoke applies at once; a grant needs approval and changes nothing', async ({ page }) => {
  await login(page, HEAD);
  let drawer = await openPermissions(page);
  await drawer.getByRole('button', { name: 'Change permissions' }).click();
  let dialog = page.getByRole('dialog', { name: 'Change permissions' });
  await dialog.getByLabel('Action 1').selectOption('REVOKE');
  await dialog.getByLabel('Permission 1').selectOption({ label: 'Write internal notes' });
  await dialog.getByLabel('Reason').fill('Moving to a read-only rotation');
  await expect(dialog.getByText('decrease · applies at once')).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply now' }).click();
  await expect(dialog).toBeHidden();
  const notes = drawer.getByRole('listitem').filter({ hasText: 'Write internal notes' });
  await expect(notes).toContainText('revoked');

  drawer = await openPermissions(page);
  await drawer.getByRole('button', { name: 'Change permissions' }).click();
  dialog = page.getByRole('dialog', { name: 'Change permissions' });
  await dialog.getByLabel('Permission 1').selectOption({ label: 'Manage queues' });
  await dialog.getByLabel('Expires on 1').fill('2030-01-31');
  await dialog.getByLabel('Reason').fill('Covering queue setup this month');
  await expect(dialog.getByText('increase · needs approval')).toBeVisible();
  await expect(dialog.getByText(/must approve it before it applies/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Request approval' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Approval required' })).toBeVisible();
  await expect(dialog).toContainText('Nothing was changed');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.reload();
  await expect(page.getByRole('dialog', { name: MEMBER.name }).getByText('Manage queues')).toHaveCount(0);
});

test('a mixed change applies its reduction at once and holds only the increase', async ({ page }) => {
  await login(page, HEAD);
  const drawer = await openPermissions(page);
  await drawer.getByRole('button', { name: 'Change permissions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change permissions' });
  await dialog.getByLabel('Action 1').selectOption('REVOKE');
  await dialog.getByLabel('Permission 1').selectOption({ label: 'Use the reply copilot' });
  await dialog.getByRole('button', { name: 'Add change' }).click();
  await dialog.getByLabel('Permission 2').selectOption({ label: 'Manage SLAs' });
  await dialog.getByLabel('Reason').fill('Rotation change with an SLA project');
  await expect(dialog.getByText('mixed · reductions apply at once, the rest needs approval')).toBeVisible();
  await expect(dialog.getByText(/reductions in this change apply as soon as you save/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Request approval' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Approval required' })).toBeVisible();
  await expect(dialog).toContainText('reductions in this change were applied');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const reopened = await openPermissions(page);
  await expect(reopened.getByRole('listitem').filter({ hasText: 'Use the reply copilot' })).toContainText('revoked');
  await expect(reopened.getByText('Manage SLAs')).toHaveCount(0);
});

test('a user waiting for approval carries a badge in People and in their drawer, and can be discarded', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/team');
  const row = people(page).getByRole('row').filter({ hasText: NEWBIE.email });
  await expect(row).toContainText('pending approval');
  await row.getByRole('link', { name: NEWBIE.name }).click();
  const drawer = page.getByRole('dialog', { name: NEWBIE.name });
  await expect(drawer).toContainText('cannot sign in until a checker approves');
  await expect(drawer.getByText('pending approval')).toBeVisible();
  await drawer.getByRole('button', { name: 'Discard', exact: true }).click();
  await drawer.getByRole('button', { name: 'Discard user' }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(people(page).getByRole('row').filter({ hasText: NEWBIE.email })).toHaveCount(0);
});
