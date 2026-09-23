import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout, settled } from './helpers';

/**
 * Virtual agent overview & configuration (design/02) against the real API:
 * seeded through the API (setup → users → scripted model provider/profile →
 * queue → a second agent), then a Lead creates an agent, takes it live,
 * edits a prompt component (the compiled prefix hash changes), creates and
 * activates a version, diffs and rolls back, and adds an escalation rule. A CS
 * Exec then sees the same agent read-only. Agents are owned by teams (ADR-026):
 * a second lead in another team cannot see Maya until the Tech admin makes
 * that team a co-owner from the agent's Settings tab.
 */
test.describe.configure({ mode: 'serial' });

const LEAD = { name: 'Ada Lead', email: 'ag.lead@e2e.ocso.test', password: 'correct-horse-battery-aglead' };
const EXEC = { name: 'Eli Exec', email: 'ag.exec@e2e.ocso.test', password: 'correct-horse-battery-agexec' };
const LEAD2 = { name: 'Lou Lead', email: 'ag.lead2@e2e.ocso.test', password: 'correct-horse-battery-aglead2' };
const NEW_LINE = '• Offer the reversal path before asking for a statement image.';

let api: APIRequestContext;
const tok = { admin: '', lead: '', lead2: '' };
const ids = { profile: '', queue: '', agent: '', cards: '', loans: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (![200, 201, 204].includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

const header = (page: Page) => page.locator('.ahead');
const tab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Agent sections' }).getByRole('tab', { name, exact: true });

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(90_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const lead = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD.name, email: LEAD.email, role: 'HEAD', password: LEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  // Agents belong to teams: each lead creates a team and the Tech admin puts them in it.
  ids.cards = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'AG Cards' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [ids.cards] });
  const lead2 = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD2.name, email: LEAD2.email, role: 'HEAD', password: LEAD2.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead2 = await loginApi(LEAD2.email, LEAD2.password);
  ids.loans = (await call<{ id: string }>('POST', '/v1/teams', tok.lead2, { name: 'AG Loans' })).id;
  await call('PATCH', `/v1/users/${lead2.id}`, tok.admin, { teamIds: [ids.loans] });
  await call('POST', '/v1/users', tok.lead, { name: EXEC.name, email: EXEC.email, role: 'SERVICE', password: EXEC.password, teamIds: [ids.cards], languages: [], maxConcurrent: 5 });
  const provider = await call<{ id: string }>('POST', '/v1/model-providers', tok.admin, { kind: 'DEV_SCRIPTED', name: 'AG Scripted', settings: { latencyMs: 50, chunkDelayMs: 15 } });
  ids.profile = (await call<{ id: string }>('POST', '/v1/model-profiles', tok.admin, { name: 'ag-support', providerId: provider.id, model: 'scripted-1', retries: 0 })).id;
  ids.queue = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'AG Cards & EMI · Tier 2' })).id;
  // A second agent so the list and the comparison have more than one row.
  await call('POST', '/v1/agents', tok.lead, { name: 'Riya', slug: 'riya-ag', purpose: 'collections', conversationType: 'COLLECTIONS', modelProfileId: ids.profile, teamIds: [ids.cards] });
  // Lou's own agent, in AG Loans.
  await call('POST', '/v1/agents', tok.lead2, { name: 'Arjun', slug: 'arjun-ag', purpose: 'loan sales', conversationType: 'SALES', modelProfileId: ids.profile, teamIds: [ids.loans] });
});

test.afterAll(async () => {
  await api?.dispose();
});

test('a Lead creates a virtual agent and takes it live', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Virtual agents', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Virtual agents' }).getByText('Riya')).toBeVisible();

  await expect(page.getByRole('table', { name: 'Virtual agents' }).getByText('Arjun')).toHaveCount(0);

  await page.getByRole('button', { name: 'New agent' }).click();
  const dialog = page.getByRole('dialog', { name: 'New virtual agent' });
  // Ada is only in AG Cards: that is the owning team.
  await expect(dialog.getByRole('group', { name: 'Owning team' }).getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByRole('checkbox', { name: 'AG Cards' })).toBeChecked();
  await dialog.getByLabel('Name').fill('Maya');
  await dialog.getByLabel('Purpose').fill('Customer Support');
  await dialog.getByLabel('Model profile').selectOption({ label: 'ag-support' });
  await dialog.getByLabel('Default queue').selectOption({ label: 'AG Cards & EMI · Tier 2' });
  await dialog.getByRole('button', { name: 'Create agent' }).click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  ids.agent = page.url().split('/agents/')[1]!;

  await expect(header(page).getByRole('heading', { name: 'Maya — Customer Support' })).toBeVisible();
  await expect(header(page).locator('.presence')).toHaveText('draft');
  await expect(header(page)).toContainText('v1');
  await expect(header(page)).toContainText('ag-support');
  await expect(header(page)).toContainText('AG Cards');

  await header(page).getByRole('button', { name: 'Go live' }).click();
  await page.getByRole('dialog', { name: 'Take Maya live' }).getByRole('button', { name: 'Go live' }).click();
  await expect(header(page).locator('.presence')).toHaveText('live');
  await expect(header(page).getByRole('button', { name: 'Pause agent' })).toBeVisible();
});

test('edits a prompt component, sees the prefix hash change, creates and activates a version', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/agents/${ids.agent}?tab=prompt`);
  await settled(page);
  await expect(tab(page, 'Prompt')).toHaveAttribute('aria-selected', 'true');
  const hash = page.getByTestId('prefix-hash');
  const before = (await hash.textContent())?.trim();
  expect(before).toMatch(/^ap_/);

  await page.getByRole('button', { name: 'Edit Behavior' }).click();
  const behavior = page.getByRole('textbox', { name: 'Behavior' });
  await behavior.fill(`${await behavior.inputValue()}\n${NEW_LINE}`);
  const card = page.locator('[data-component="behavior"]');
  await expect(card).toContainText('edited · unsaved');
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expect(card).toContainText('draft · not live');
  await expect(hash).not.toHaveText(before!);
  await expect(page.locator('.prompt-foot')).toContainText('prompt hash changes');

  await page.getByRole('button', { name: 'Create version v2' }).click();
  const create = page.getByRole('dialog', { name: 'Create version v2' });
  await create.getByLabel('Reason for this change').fill('Duplicate-debit path shortened');
  await create.getByRole('button', { name: 'Create v2' }).click();
  const created = page.getByRole('dialog', { name: 'v2 created' });
  await expect(created).toContainText('Not live yet');
  await created.getByRole('button', { name: 'Activate v2 now' }).click();
  await expect(created).toContainText('v2 is live');
  await created.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(header(page)).toContainText('v2');
  await expect(card).not.toContainText('draft · not live');
  await expect(page.getByRole('region', { name: 'Live version' })).toContainText('Duplicate-debit path shortened');
  await expect(page.getByRole('region', { name: 'Live version' })).toContainText(LEAD.name);
});

test('views the diff between versions and rolls back', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/agents/${ids.agent}?tab=versions`);
  const versions = page.getByRole('list', { name: 'Prompt versions' });
  await expect(versions.locator('[data-version="2"]')).toHaveClass(/live/);
  await expect(versions.locator('[data-version="2"]')).toContainText('Duplicate-debit path shortened');
  await expect(versions.locator('[data-version="2"]')).toContainText(LEAD.name);

  await page.getByRole('link', { name: 'Diff v1 to v2' }).click();
  const diff = page.getByRole('region', { name: 'Diff v1 to v2' });
  await expect(diff).toContainText('Behavior');
  await expect(diff.locator('.dl.add')).toContainText(NEW_LINE);

  await page.getByRole('button', { name: 'Roll back to v1' }).click();
  await page.getByRole('dialog', { name: 'Roll back to v1' }).getByRole('button', { name: 'Roll back to v1' }).click();
  await expect(versions.locator('[data-version="1"]')).toHaveClass(/live/);
  await expect(versions.locator('[data-version="2"]')).not.toHaveClass(/live/);
  await expect(header(page)).toContainText('v1');
  await expect(page.getByRole('button', { name: 'Activate v2' })).toBeVisible();
});

test('replays the saved draft against history, then discards the draft', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, LEAD);
  await page.goto(`/agents/${ids.agent}?tab=prompt`);
  await page.getByRole('button', { name: 'Edit Identity' }).click();
  const identity = page.getByRole('textbox', { name: 'Identity' });
  await identity.fill(`${await identity.inputValue()} You speak plainly.`);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('[data-component="identity"]')).toContainText('draft · not live');

  await page.getByRole('button', { name: 'Run against 40 replay cases' }).click();
  await page.waitForURL(/tab=versions&run=/);
  const runs = page.getByRole('table', { name: 'Replay evaluation runs' });
  await expect(runs.getByRole('row')).toHaveCount(2);
  // The worker replays resolved conversations of this agent; a new agent has none, so the run completes with 0 cases.
  await expect(runs).toContainText('completed', { timeout: 45_000 });
  await expect(page.getByRole('region', { name: /Draft vs v1 · replay/ })).toContainText('cases');

  await page.goto(`/agents/${ids.agent}?tab=prompt`);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog', { name: 'Discard the saved draft' }).getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.locator('[data-component="identity"]')).not.toContainText('draft · not live');
  await expect(page.locator('.prompt-foot')).toContainText('0 components differ from live');
});

test('adds an escalation rule', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/agents/${ids.agent}?tab=escalation`);
  await page.getByRole('button', { name: 'Add rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add escalation rule' });
  await dialog.getByLabel('Rule name').fill('Hardship language');
  await dialog.getByLabel('Trigger').selectOption('RISK');
  await dialog.getByLabel('Keywords').fill('hardship, job loss');
  await dialog.getByLabel('Priority').selectOption('P1');
  await dialog.getByRole('button', { name: 'Add rule' }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole('table', { name: 'Escalation rules' }).getByRole('row', { name: /Hardship language/ });
  await expect(row).toContainText('keywords: hardship, job loss');
  await expect(row).toContainText('P1');
  await expect(row).toContainText('this agent');
  await expect(row).toContainText('AG Cards & EMI · Tier 2 (default)');
  await logout(page);
});

test('sets human business hours; an invalid span shows the API error inline', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/agents/${ids.agent}?tab=settings`);
  await expect(header(page)).toContainText('AI 24×7 · humans 24×7');
  const form = page.getByRole('form', { name: 'Business hours' });
  await form.getByLabel('Humans available 24×7').uncheck();
  await form.getByLabel('Time zone').selectOption('Asia/Kolkata');
  const days = form.getByRole('group', { name: 'Human hours by day' });
  await days.getByLabel('Monday', { exact: true }).check();
  await days.getByLabel('Monday opens').fill('18:00');
  await days.getByLabel('Monday closes').fill('09:00');
  await form.getByRole('button', { name: 'Save business hours' }).click();
  // Validated by the API (open < close), shown next to the day.
  await expect(form.locator('#bh-mon-err')).toHaveText('Opening time must be before closing time');
  await expect(days.getByLabel('Monday opens')).toHaveAttribute('aria-invalid', 'true');

  await days.getByLabel('Monday opens').fill('08:00');
  await days.getByLabel('Monday closes').fill('23:00');
  await days.getByLabel('Tuesday', { exact: true }).check();
  await form.getByRole('button', { name: 'Save business hours' }).click();
  await expect(form).toContainText('Business hours saved');
  await expect(form.locator('#bh-mon-err')).toHaveCount(0);
  await expect(header(page)).toContainText('humans varies by day (2 days, Asia/Kolkata)');
  await page.reload();
  await expect(page.getByRole('form', { name: 'Business hours' }).getByLabel('Monday closes')).toHaveValue('23:00');
  await logout(page);
});

test('a Service member reads the agent without edit controls', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/agents/${ids.agent}`);
  await expect(header(page).getByRole('heading', { name: 'Maya — Customer Support' })).toBeVisible();
  for (const name of ['Pause agent', 'Go live']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Create new version' })).toHaveCount(0);
  for (const name of ['Analytics', 'Quality', 'Channels']) await expect(tab(page, name)).toHaveCount(0);
  await expect(page.getByText('waiting for a human')).toBeVisible();

  await tab(page, 'Prompt').click();
  await expect(page.locator('[data-component="behavior"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Behavior' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Save draft|Create version/ })).toHaveCount(0);

  await tab(page, 'Versions').click();
  await expect(page.getByRole('list', { name: 'Prompt versions' }).locator('[data-version="2"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /Roll back|Activate/ })).toHaveCount(0);

  await tab(page, 'Escalation').click();
  await expect(page.getByRole('table', { name: 'Escalation rules' })).toContainText('Hardship language');
  await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Edit Hardship|Delete Hardship/ })).toHaveCount(0);

  await tab(page, 'Settings').click();
  await expect(page.getByRole('region', { name: 'Models and runtime' })).toContainText('ag-support');
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Business hours' })).toContainText('08:00–23:00');
  await expect(page.getByRole('button', { name: 'Save business hours' })).toHaveCount(0);
  await logout(page);
});

test('a lead in another team cannot see Maya until the Tech admin makes their team a co-owner', async ({ page }) => {
  await login(page, LEAD2);
  await page.goto('/agents');
  const list = page.getByRole('table', { name: 'Virtual agents' });
  await expect(list.getByText('Arjun')).toBeVisible();
  await expect(list.getByText('Maya')).toHaveCount(0);
  await expect(list.getByText('Riya')).toHaveCount(0);
  await page.goto(`/agents/${ids.agent}`);
  await expect(page.getByRole('heading', { name: 'Agent not found' })).toBeVisible();
  await page.goto(`/agents/${ids.agent}?tab=prompt`);
  await expect(page.getByRole('heading', { name: 'Agent not found' })).toBeVisible();
  await logout(page);

  await login(page, ACCOUNTS.admin);
  await page.goto(`/agents/${ids.agent}?tab=settings`);
  const owners = page.getByRole('form', { name: 'Owning teams' });
  await expect(owners.getByRole('checkbox', { name: 'AG Cards' })).toBeChecked();
  await owners.getByRole('checkbox', { name: 'AG Loans' }).check();
  await owners.getByRole('button', { name: 'Save owning teams' }).click();
  await expect(owners).toContainText('Owning teams saved');
  await expect(header(page)).toContainText('AG Cards · AG Loans');
  // Governance only: the Tech admin cannot edit the agent's business settings.
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await logout(page);

  await login(page, LEAD2);
  await page.goto('/agents');
  await expect(page.getByRole('table', { name: 'Virtual agents' }).getByText('Maya')).toBeVisible();
  await page.goto(`/agents/${ids.agent}?tab=settings`);
  const leadOwners = page.getByRole('form', { name: 'Owning teams' });
  // Lou may change AG Loans (his team), not AG Cards.
  await expect(leadOwners.getByRole('checkbox', { name: /AG Cards/ })).toBeDisabled();
  await expect(leadOwners.getByRole('checkbox', { name: 'AG Loans' })).toBeEnabled();
  await logout(page);
});
