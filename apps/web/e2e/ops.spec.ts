import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout, primaryNav, settled } from './helpers';

/**
 * CS Lead operations pages against the real API + worker. Seeded through the
 * API (setup → lead/exec/team → scripted model → agent → web chat); the lead
 * then creates an SLA policy and a queue, reads analytics before and after a
 * web-chat customer escalates, records / stages / rejects prompt corrections,
 * reviews the resolved conversation and edits the customer. The CS Exec must
 * not see lead-only controls.
 */
test.describe.configure({ mode: 'serial' });

const LEAD = { name: 'Olga Lead', email: 'ops.lead@e2e.ocso.test', password: 'correct-horse-battery-opslead' };
const EXEC = { name: 'Omar Exec', email: 'ops.exec@e2e.ocso.test', password: 'correct-horse-battery-opsexec' };
const TEAM = 'OPS Cards team';
const QUEUE = 'OPS Cards · Tier 2';
const POLICY = 'OPS Standard';
const AGENT = 'Mira Ops';

let api: APIRequestContext;
const tok = { admin: '', lead: '' };
const ids = { team: '', seedQueue: '', agent: '', webchatKey: '', conversation: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (![200, 201, 204].includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;
const tile = (page: Page, label: RegExp) => page.locator('.tile').filter({ has: page.locator('.k', { hasText: label }) });

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(90_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const lead = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD.name, email: LEAD.email, role: 'CS_LEAD', password: LEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  ids.team = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: TEAM })).id;
  // The lead manages the agent through an owning team of their own, outside the queue's team (ADR-026).
  const owners = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'OPS Agent owners' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [owners] });
  await call('POST', '/v1/users', tok.lead, { name: EXEC.name, email: EXEC.email, role: 'CS_EXEC', password: EXEC.password, teamIds: [ids.team], languages: [], maxConcurrent: 5 });
  ids.seedQueue = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'OPS Seed queue', teamIds: [ids.team] })).id;

  const provider = await call<{ id: string }>('POST', '/v1/model-providers', tok.admin, { kind: 'DEV_SCRIPTED', name: 'OPS Scripted', settings: { latencyMs: 50, chunkDelayMs: 15 } });
  const profile = await call<{ id: string }>('POST', '/v1/model-profiles', tok.admin, { name: 'ops-support', providerId: provider.id, model: 'scripted-1', retries: 0 });
  ids.agent = (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name: AGENT, slug: 'mira-ops', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile.id, defaultQueueId: ids.seedQueue, teamIds: [owners] })).id;
  await call('POST', `/v1/agents/${ids.agent}/status`, tok.lead, { status: 'LIVE' });
  const channel = await call<{ publicKey: string }>('POST', '/v1/channels', tok.admin, { kind: 'WEBCHAT', name: 'OPS Web chat', status: 'ACTIVE', defaultAgentId: ids.agent, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } });
  ids.webchatKey = channel.publicKey;
});

test.afterAll(async () => {
  await api?.dispose();
});

test('analytics and escalation reasons say plainly when there is no data yet', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/analytics');
  await settled(page);
  await expect(page.getByText('No conversations opened in the last 7 days')).toBeVisible();
  await expect(tile(page, /^conversations\d*$/).locator('.v')).toHaveText('0');
  await expect(tile(page, /^ai containment/)).toContainText('no data in window');
  await expect(page.getByRole('table', { name: 'Agent comparison' })).toContainText(AGENT);
  await expect(page.getByRole('heading', { name: 'How these numbers are computed' })).toBeVisible();
  await expect(page.locator('#def-2')).toContainText('no handoff row of any trigger');
  await page.getByRole('link', { name: '30d' }).click();
  await expect(page.getByRole('link', { name: '30d' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No conversations opened in the last 30 days')).toBeVisible();

  await page.goto('/escalation-reasons');
  await expect(page.getByRole('heading', { name: 'No escalations in the last 7 days' })).toBeVisible();
});

test('the lead creates an SLA policy and a queue that uses it', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/sla');
  await settled(page);
  await page.getByRole('button', { name: 'New SLA policy' }).first().click();
  const sla = page.getByRole('dialog', { name: 'New SLA policy' });
  await sla.getByLabel('Policy name').fill(POLICY);
  await sla.getByLabel('First human response (minutes)').fill('15');
  await sla.getByLabel('P1', { exact: true }).fill('5');
  await sla.getByLabel('support', { exact: true }).fill('4');
  await sla.getByLabel('At risk after (% of the window)').fill('80');
  await sla.getByRole('button', { name: 'Create policy' }).click();
  await expect(sla).toBeHidden();
  const card = page.getByRole('region', { name: `SLA policy ${POLICY}` });
  await expect(card).toContainText('at risk after 80%');
  await expect(card).toContainText('15m');
  await expect(card).toContainText('support 4h');
  await expect(card).toContainText('not attached to a queue');

  await page.goto('/queues');
  await settled(page);
  await page.getByRole('button', { name: 'New queue' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New queue' });
  await dialog.getByLabel('Queue name').fill(QUEUE);
  await dialog.getByLabel('Description').fill('Card and EMI escalations');
  await dialog.getByLabel('Auto-assign after (seconds)').fill('600');
  await dialog.getByLabel(TEAM).check();
  await dialog.getByLabel('Required skills').fill('cards, emi');
  await dialog.getByLabel('Languages').fill('en, hi');
  await dialog.getByLabel('SLA policy').selectOption({ label: POLICY });
  await dialog.getByRole('button', { name: 'Create queue' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('table', { name: 'Queues' }).getByRole('row').filter({ hasText: QUEUE });
  await expect(row).toContainText('Open pickup');
  await expect(row).toContainText('auto-assign after 10m');
  await expect(row).toContainText(TEAM);
  await expect(row).toContainText('cards, emi · en, hi');
  await expect(row.getByRole('link', { name: POLICY })).toHaveAttribute('href', /\/sla#sla-/);

  await row.getByRole('button', { name: `Edit ${QUEUE}` }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${QUEUE}` });
  await edit.getByLabel('Routing mode').selectOption('AUTO_ASSIGN');
  await edit.getByLabel('Accept within (seconds)').fill('90');
  await edit.getByRole('button', { name: 'Save queue' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText('Auto-assign');
  await expect(row).toContainText('accept within 1m 30s');

  // Back to open pickup so the escalation below waits in the queue with a pickup clock.
  await row.getByRole('button', { name: `Edit ${QUEUE}` }).click();
  await edit.getByLabel('Routing mode').selectOption('OPEN_PICKUP');
  await edit.getByRole('button', { name: 'Save queue' }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText('Open pickup');
  await expect(row).toContainText('claimed by eligible execs');

  await page.goto('/sla');
  await expect(page.getByRole('region', { name: `SLA policy ${POLICY}` })).toContainText(QUEUE);
});

test('a web-chat customer escalates into the new queue; analytics, reasons and SLA show it', async ({ page }) => {
  test.setTimeout(120_000);
  const queues = await call<Array<{ id: string; name: string }>>('GET', '/v1/queues', tok.lead);
  const queueId = queues.find((q) => q.name === QUEUE)?.id;
  expect(queueId).toBeTruthy();
  await call('PATCH', `/v1/agents/${ids.agent}`, tok.lead, { defaultQueueId: queueId });

  const visitor = (await call<{ token: string }>('POST', `/public/webchat/${ids.webchatKey}/session`, null, {})).token;
  const say = async (text: string) => (await call<{ conversationId: string }>('POST', `/public/webchat/${ids.webchatKey}/messages`, visitor, { clientMessageId: `c-${randomBytes(6).toString('hex')}`, text })).conversationId;
  ids.conversation = await say('My EMI was debited twice this month');
  await expect.poll(async () => (await call<{ messages: Array<{ from: string }> }>('GET', `/public/webchat/${ids.webchatKey}/messages`, visitor)).messages.map((m) => m.from), { timeout: 45_000, intervals: [500] }).toContain('agent');
  await say('I would like to talk to a human please');
  await expect.poll(async () => (await call<{ controlState: string }>('GET', `/v1/conversations/${ids.conversation}`, tok.lead)).controlState, { timeout: 45_000, intervals: [500] }).toBe('WAITING_FOR_HUMAN');

  await login(page, LEAD);
  await page.goto('/analytics');
  await settled(page);
  await expect(page.getByText('No conversations opened in the last 7 days')).toHaveCount(0);
  await expect(tile(page, /^conversations\d*$/).locator('.v')).toHaveText('1');
  await expect(tile(page, /^escalation rate/).locator('.v')).toHaveText('100.0%');
  await expect(page.getByRole('table', { name: 'Queue performance' }).getByRole('row').filter({ hasText: QUEUE })).toContainText('1');

  await page.goto('/escalation-reasons');
  await settled(page);
  await expect(tile(page, /^escalations/).locator('.v')).toHaveText('1');
  const reasons = page.getByRole('table', { name: 'Escalation reasons' });
  await expect(reasons.getByRole('row')).toHaveCount(2);
  await expect(reasons).toContainText(AGENT);
  await expect(reasons).toContainText(QUEUE);

  await page.goto('/sla');
  await settled(page);
  const waiting = page.getByRole('table', { name: 'Conversations waiting for a human' });
  await expect(waiting.getByRole('row').filter({ hasText: AGENT })).toContainText('to SLA');
  await expect(tile(page, /^waiting now/).locator('.v')).toHaveText('1');
});

test('the lead records a correction, stages it into the draft, and rejects another', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/corrections');
  await settled(page);
  const record = async (title: string) => {
    await page.getByRole('button', { name: 'New correction' }).click();
    const dialog = page.getByRole('dialog', { name: 'New prompt correction' });
    await dialog.getByLabel('Virtual agent').selectOption({ label: AGENT });
    await dialog.getByLabel('Prompt component').selectOption('behavior');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByLabel('Observed problem').fill('Asked for a statement image already on file');
    await dialog.getByLabel('Desired behaviour').fill('Check the ledger first, then offer the reversal path');
    await dialog.getByLabel('Proposed prompt text').fill(`• ${title}.`);
    await dialog.getByRole('button', { name: 'Record correction' }).click();
    await expect(dialog).toBeHidden();
  };
  await record('Offer the reversal before asking for a statement');
  await record('Stop promising a 24h resolution');
  const table = page.getByRole('table', { name: 'Prompt corrections' });
  await expect(table.getByRole('row')).toHaveCount(3);

  await table.getByRole('link', { name: 'Offer the reversal before asking for a statement' }).click();
  const drawer = page.getByRole('dialog', { name: 'Offer the reversal before asking for a statement' });
  await expect(drawer).toContainText('Asked for a statement image already on file');
  await drawer.getByRole('button', { name: 'Stage into draft' }).click();
  await expect(drawer).toContainText('Staged into the behavior draft');
  await expect(drawer.getByRole('link', { name: 'Create a version from the draft' })).toHaveAttribute('href', `/agents/${ids.agent}?tab=prompt`);
  await expect(page.getByRole('region', { name: 'Staged · waiting for a version' }).getByRole('link', { name: 'Create version' })).toHaveAttribute('href', `/agents/${ids.agent}?tab=prompt`);
  await drawer.getByRole('button', { name: 'Close' }).click();

  await table.getByRole('link', { name: 'Stop promising a 24h resolution' }).click();
  const second = page.getByRole('dialog', { name: 'Stop promising a 24h resolution' });
  await second.getByLabel('Reject with a reason').fill('policy already covers it');
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(second.getByText('rejected', { exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Reject' })).toHaveCount(0);
  await second.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('link', { name: /^staged/ }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('Offer the reversal');
  await page.getByRole('link', { name: /^rejected/ }).click();
  await expect(table).toContainText('Stop promising a 24h resolution');

  const draft = await call('GET', `/v1/agents/${ids.agent}/prompt`, tok.lead);
  expect(JSON.stringify(draft)).toContain('Offer the reversal before asking for a statement');
});

test('the lead reviews the resolved conversation against the rubric', async ({ page }) => {
  await call('POST', `/v1/conversations/${ids.conversation}/resolve`, tok.lead, { disposition: 'duplicate debit reversed' });
  await login(page, LEAD);
  await page.goto('/reviews');
  await settled(page);
  const queue = page.getByRole('table', { name: 'Conversations to review' });
  const row = queue.getByRole('row').filter({ hasText: AGENT });
  await expect(row).toContainText('duplicate debit reversed');
  await row.getByRole('button', { name: /^Review / }).click();
  const dialog = page.getByRole('dialog', { name: /^Review / });
  for (const [criterion, score] of [['accuracy', '5'], ['policy', '4'], ['tone', '4'], ['resolution', '3']] as const) {
    await dialog.getByRole('group', { name: criterion }).getByText(score, { exact: true }).click();
  }
  await expect(dialog).toContainText('score 4.00');
  await dialog.getByLabel('Outcome').fill('good handoff');
  await dialog.getByLabel('Notes').fill('clean summary for the human');
  await dialog.getByRole('button', { name: 'Submit review' }).click();
  await expect(dialog).toBeHidden();
  const reviewed = page.getByRole('table', { name: 'Reviewed conversations' }).getByRole('row').filter({ hasText: AGENT });
  await expect(reviewed).toContainText('good handoff');
  await expect(reviewed).toContainText('4.0');
  await expect(reviewed).toContainText(LEAD.name);
  await expect(reviewed.getByRole('link').first()).toHaveAttribute('href', `/conversations/${ids.conversation}`);
  await expect(queue.getByRole('row').filter({ hasText: AGENT })).toHaveCount(0);
});

test('the lead finds the web-chat customer, sees identities and conversations, and edits them', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/customers');
  await settled(page);
  const table = page.getByRole('table', { name: 'Customers' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await table.getByRole('link', { name: 'Unnamed customer' }).click();
  const drawer = page.getByRole('dialog', { name: 'Unnamed customer' });
  await expect(drawer).toContainText('1 conversation');
  await expect(drawer.getByRole('link', { name: /resolved/i })).toHaveAttribute('href', `/conversations/${ids.conversation}`);
  await expect(drawer.getByRole('region', { name: /Identities · 1/ })).toContainText(/verified/);

  await drawer.getByRole('button', { name: 'Edit customer' }).click();
  const form = drawer.getByRole('form', { name: 'Edit customer' });
  await form.getByLabel('Display name').fill('Priya Ops');
  await form.getByLabel('Language').fill('en');
  await form.getByLabel('Attributes (JSON)').fill('{"segment":"priority"}');
  await form.getByRole('button', { name: 'Save customer' }).click();
  const saved = page.getByRole('dialog', { name: 'Priya Ops' });
  await expect(saved).toContainText('segment');
  await expect(saved).toContainText('priority');

  await page.goto('/customers');
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('priya');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/q=priya/);
  await expect(page.getByRole('heading', { name: 'Results for “priya”' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Customers' }).getByRole('link', { name: 'Priya Ops' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search customers' }).fill('nobody-by-this-name');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('heading', { name: 'No customer matches' })).toBeVisible();
  await logout(page);
});

test('the CS Exec gets the pickup view and none of the lead-only controls', async ({ page }) => {
  await login(page, EXEC);
  const nav = primaryNav(page);
  await expect(nav.getByRole('link', { name: 'Pickup queue' })).toBeVisible();
  for (const hidden of ['Analytics', 'Reviews', 'Prompt corrections', 'Escalation reasons', 'SLA policies']) await expect(nav.getByRole('link', { name: hidden })).toHaveCount(0);

  await page.goto('/queues');
  await settled(page);
  await expect(page.getByRole('heading', { name: 'Pickup queue', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Conversations waiting for pickup' }).or(page.getByRole('heading', { name: 'Nobody is waiting' }))).toBeVisible();
  await expect(page.getByRole('table', { name: 'Queues' })).toContainText(QUEUE);
  await expect(page.getByRole('button', { name: 'New queue' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'SLA policies' })).toHaveCount(0);

  await page.goto('/sla');
  await settled(page);
  await expect(page.getByRole('region', { name: `SLA policy ${POLICY}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New SLA policy' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);

  for (const path of ['/analytics', '/escalation-reasons', '/reviews', '/corrections']) {
    await page.goto(path);
    await expect(page.getByText('Not available for your role')).toBeVisible();
  }

  await page.goto('/customers');
  await settled(page);
  await expect(page.getByText('customers you have a permitted conversation with')).toBeVisible();
  // The resolved conversation sits in a queue of the exec's team, so the customer is visible — read-only.
  await page.getByRole('table', { name: 'Customers' }).getByRole('link', { name: 'Priya Ops' }).click();
  const drawer = page.getByRole('dialog', { name: 'Priya Ops' });
  await expect(drawer).toContainText('priority');
  await expect(drawer.getByRole('button', { name: 'Edit customer' })).toHaveCount(0);
});
