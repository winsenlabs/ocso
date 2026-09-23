import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { expectNavLinksResolve, login, logout } from './helpers';
import { approvedChannel, approvedProfile, approvedProvider } from './platform-setup';

/**
 * Maker–checker end to end (PM/research/11 §4, 11b): a Lead submits taking an
 * agent live from its page, a Head approves it from the queue with the diff in
 * front of them, bulk approve leaves the proposals with warnings alone, a
 * rejection goes back to the maker who resubmits. Seeded through the real API.
 */
test.describe.configure({ mode: 'serial' });

const LEAD = { name: 'Lina Maker', email: 'ap.lead@e2e.ocso.test', password: 'correct-horse-battery-aplead' };
const HEAD = { name: 'Hari Checker', email: 'ap.head@e2e.ocso.test', password: 'correct-horse-battery-aphead' };
const HEAD2 = { name: 'Hema Second', email: 'ap.head2@e2e.ocso.test', password: 'correct-horse-battery-aphead2' };
const SERVICE = { name: 'Sami Service', email: 'ap.service@e2e.ocso.test', password: 'correct-horse-battery-apserv' };

let api: APIRequestContext;
const tok: Record<'admin' | 'lead' | 'head', string> = { admin: '', lead: '', head: '' };
const ids: Record<string, string> = {};

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, token: string | null, body?: unknown, ok: number[] = [200, 201, 204]): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (!ok.includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;
const newAgent = async (name: string) => (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name, conversationType: 'SUPPORT', modelProfileId: ids.profile, teamIds: [ids.team] })).id;
const submitLive = async (agentId: string, checkerId: string) =>
  (await call<{ proposal: { id: string } }>('POST', `/v1/agents/${agentId}/status`, tok.lead, { status: 'LIVE', approval: { checkerId, reason: 'Ready for customers' } }, [202])).proposal.id;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(90_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const mk = async (who: { name: string; email: string; password: string }, role: string) =>
    (await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: who.name, email: who.email, role, password: who.password, teamIds: [], languages: [], maxConcurrent: 5 })).id;
  ids.lead = await mk(LEAD, 'LEAD');
  ids.head = await mk(HEAD, 'HEAD');
  ids.head2 = await mk(HEAD2, 'HEAD');
  ids.service = await mk(SERVICE, 'SERVICE');
  tok.head = await loginApi(HEAD.email, HEAD.password);
  ids.team = (await call<{ id: string }>('POST', '/v1/teams', tok.head, { name: 'AP Cards' })).id;
  for (const who of ['lead', 'head', 'head2', 'service']) await call('PATCH', `/v1/users/${ids[who]}`, tok.admin, { teamIds: [ids.team] });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  // A provider is a disabled draft until a Head approves enabling it (PM/research/11 §4).
  const provider = await approvedProvider(api, tok.admin, { id: ids.head!, token: tok.head }, { kind: 'DEV_SCRIPTED', name: 'AP Scripted', settings: { latencyMs: 10, chunkDelayMs: 5 } });
  ids.profile = await approvedProfile(api, tok.admin, { id: ids.head!, token: tok.head }, { name: 'ap-support', providerId: provider, model: 'scripted-1', retries: 0 });
  ids.nova = await newAgent('Nova');
});

test.afterAll(async () => {
  await api?.dispose();
});

const drawer = (page: Page) => page.getByRole('dialog', { name: /Take Nova live|Change Nova/ });

test('a Lead submits taking an agent live and sees it under “Sent by me” with the diff', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/agents/${ids.nova}`);
  await page.getByRole('button', { name: 'Go live' }).click();
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(modal.getByLabel('checker')).toContainText(HEAD.name);
  await modal.getByLabel('checker').selectOption({ label: HEAD.name });
  await modal.getByLabel('reason').fill('Prompt reviewed with compliance');
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Sent for approval')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: /Pending approval · awaiting Hari Checker/ })).toBeVisible();

  await page.goto('/approvals?box=sent');
  const table = page.getByRole('table', { name: 'Approvals' });
  await table.getByRole('link', { name: /Take Nova live/ }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('table', { name: 'Proposed change' })).toContainText('status');
  await expect(drawer(page).getByRole('table', { name: 'Proposed change' })).toContainText('LIVE');
  await expect(drawer(page)).toContainText(`Waiting for ${HEAD.name} to decide.`);
  await logout(page);
});

test('a Head approves it from “Awaiting me”; the agent is live', async ({ page }) => {
  await login(page, HEAD);
  await page.goto('/approvals');
  await page.getByRole('table', { name: 'Approvals' }).getByRole('link', { name: /Take Nova live/ }).click();
  await expect(drawer(page).getByRole('table', { name: 'Proposed change' })).toContainText('DRAFT');
  // The whole configuration going live is in front of the checker, prompt text included.
  const live = drawer(page).getByRole('table', { name: 'What goes live' });
  await expect(live).toContainText('prompt text');
  await expect(live).toContainText('escalation rules');
  await drawer(page).getByLabel('reason (required to reject)').fill('Checked the prompt and profile');
  await drawer(page).getByRole('button', { name: 'Approve' }).click();
  await expect(drawer(page)).toContainText('approved');
  await page.goto(`/agents/${ids.nova}`);
  await expect(page.locator('.ahead')).toContainText('live');
  await expect(page.getByRole('button', { name: 'Pause agent' })).toBeVisible();
  await logout(page);
});

test('bulk approve: blocking warnings stay out; the bar counts them', async ({ page }) => {
  const agents = await Promise.all(['Bulk A', 'Bulk B', 'Bulk C', 'Bulk D', 'Bulk E'].map(newAgent));
  const proposals = [];
  for (const a of agents) proposals.push(await submitLive(a, ids.head!));
  // Two carry a blocking warning: the maker edited them after submitting.
  for (const id of proposals.slice(3)) await call('PATCH', `/v1/approvals/${id}`, tok.lead, { reason: 'Edited after submission' });

  await login(page, HEAD);
  await page.goto('/approvals');
  const table = page.getByRole('table', { name: 'Approvals' });
  await expect(table.getByRole('row')).toHaveCount(6);
  await table.getByRole('checkbox', { name: 'Select all that can be approved together' }).check();
  await expect(table.getByRole('checkbox', { name: 'Select Take Bulk D live' })).toBeDisabled();
  await expect(table.getByRole('checkbox', { name: 'Select Take Bulk E live' })).toBeDisabled();
  const bar = page.getByRole('region', { name: 'Bulk approve' });
  await expect(bar).toContainText('Approve 3 selected · 2 excluded');
  await bar.getByLabel('Reason for the approvals').fill('Batch go-live after review');
  await bar.getByRole('button', { name: 'Approve 3' }).click();
  await expect(bar).toContainText('3 approved');
  await page.reload();
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table).toContainText('Take Bulk D live');
  await expect(table).toContainText('Take Bulk E live');
  await logout(page);
});

test('a rejection returns the change to the maker, who resubmits', async ({ page }) => {
  const proposal = (await call<{ proposal: { id: string } }>('PATCH', `/v1/agents/${ids.nova}`, tok.lead, { purpose: 'card disputes', approval: { checkerId: ids.head, reason: 'Narrow the purpose' } }, [202])).proposal.id;
  await login(page, HEAD);
  await page.goto(`/approvals?approval=${proposal}`);
  const d = drawer(page);
  await expect(d.getByRole('table', { name: 'Proposed change' })).toContainText('card disputes');
  await expect(d.getByRole('button', { name: 'Reject' })).toBeDisabled();
  await d.getByLabel('reason (required to reject)').fill('Keep the broader purpose for now');
  await d.getByRole('button', { name: 'Reject' }).click();
  await expect(d).toContainText('rejected');
  await logout(page);

  await login(page, LEAD);
  await page.goto(`/approvals?box=decided&approval=${proposal}`);
  await expect(drawer(page)).toContainText('Keep the broader purpose for now');
  // Resubmit from the agent's settings: the save continues into the submit modal.
  await page.goto(`/agents/${ids.nova}?tab=settings`);
  await page.getByLabel('Purpose').fill('card disputes and EMI');
  await page.getByRole('form', { name: 'Agent settings' }).getByRole('button', { name: /Save/ }).click();
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await modal.getByLabel('checker').selectOption({ label: HEAD2.name });
  await modal.getByLabel('reason').fill('Broader purpose, as agreed');
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Sent for approval')).toBeVisible();
  await page.goto('/approvals?box=sent');
  await expect(page.getByRole('table', { name: 'Approvals' })).toContainText('Change Nova: purpose');
  await logout(page);
});

test('Tech voids a proposal nobody can decide any more, with a reason', async ({ page }) => {
  const sent = await call<{ rows: Array<{ id: string; title: string }> }>('GET', '/v1/approvals?box=SENT_BY_ME&limit=50', tok.lead);
  const open = sent.rows.find((r) => r.title.startsWith('Change Nova'))!;
  await login(page, ACCOUNTS.admin);
  await page.goto(`/approvals?box=open&approval=${open.id}`);
  const d = page.getByRole('dialog', { name: /Change Nova/ });
  await d.getByPlaceholder('Why this proposal is closed without a decision').fill('Checker left the bank; closing it');
  await d.getByRole('button', { name: 'Void proposal' }).click();
  await expect(d).toContainText('void');
  await expect(d).toContainText('Checker left the bank; closing it');
  await logout(page);
});

test('a Service member reads the queue with nothing to decide; every sidebar link resolves', async ({ page }) => {
  await login(page, SERVICE);
  await page.goto('/approvals');
  await expect(page.getByText('Nothing is waiting for your decision.')).toBeVisible();
  await logout(page);
  await login(page, HEAD);
  await expectNavLinksResolve(page);
});
