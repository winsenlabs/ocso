import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout } from './helpers';

/**
 * The router builder under maker–checker (PM/research/11 §4, §5.7): a Lead
 * builds two attribute queues (English / Tamil) and a language menu router in
 * the UI, submits them; a Head approves them from the approvals queue; a web
 * chat customer taps Tamil and lands in the Tamil queue — shown by the routing
 * card, the agent's "Reached through" list and the channel screen. The agents,
 * channel, provider and profile are set up through the real API and their own
 * approvals (a second checker, never a bootstrap).
 */
test.describe.configure({ mode: 'serial' });

const LEAD = { name: 'Rani Builder', email: 'rw.lead@e2e.ocso.test', password: 'correct-horse-battery-rwlead' };
const HEAD = { name: 'Harsh Approver', email: 'rw.head@e2e.ocso.test', password: 'correct-horse-battery-rwhead' };
const TECH2 = { name: 'Tom Second Tech', email: 'rw.tech2@e2e.ocso.test', password: 'correct-horse-battery-rwtech2' };
const CHANNEL = 'RW Language chat';
const ROUTER = 'RW Language menu';

let api: APIRequestContext;
const tok: Record<'admin' | 'lead' | 'head' | 'tech2', string> = { admin: '', lead: '', head: '', tech2: '' };
const ids: Record<string, string> = {};

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, token: string | null, body?: unknown, ok: number[] = [200, 201, 202, 204]): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (!ok.includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

/**
 * Setup objects of other approvable kinds (model provider/profile, channel) go through their own approval when
 * their kind is registered and they are not approved yet: submitted by `maker`, approved by `checker`.
 */
async function ensureApproved(kind: string, objectId: string, maker: string, checker: { token: string; id: string }): Promise<void> {
  const kinds = await call<Array<{ kind: string; actions: string[] }>>('GET', '/v1/approvals/kinds', maker);
  const k = kinds.find((x) => x.kind === kind);
  if (!k) return;
  const state = await call<{ approved: boolean }>('GET', `/v1/approvals/state?objectKind=${kind}&objectId=${objectId}`, maker);
  if (state.approved) return;
  const action = ['ACTIVATE', 'CREATE'].find((a) => k.actions.includes(a));
  if (!action) return;
  const p = await call<{ id: string; contentHash: string }>('POST', '/v1/approvals', maker, { objectKind: kind, objectId, action, checkerId: checker.id, reason: 'E2E setup: reviewed configuration' });
  await call('POST', `/v1/approvals/${p.id}/decision`, checker.token, { decision: 'APPROVE', reason: 'E2E setup: reviewed', contentHash: p.contentHash });
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
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
  ids.tech2 = await mk(TECH2, 'TECH');
  tok.head = await loginApi(HEAD.email, HEAD.password);
  tok.tech2 = await loginApi(TECH2.email, TECH2.password);
  ids.team = (await call<{ id: string }>('POST', '/v1/teams', tok.head, { name: 'RW Language desk' })).id;
  for (const who of ['lead', 'head']) await call('PATCH', `/v1/users/${ids[who]}`, tok.admin, { teamIds: [ids.team] });
  tok.lead = await loginApi(LEAD.email, LEAD.password);

  // Platform configuration: a Tech makes it, another Tech checks it (approvals.check.platform).
  const platformChecker = { token: tok.tech2, id: ids.tech2 };
  const provider = (await call<{ id: string }>('POST', '/v1/model-providers', tok.admin, { kind: 'DEV_SCRIPTED', name: 'RW Scripted', enabled: false, settings: { latencyMs: 10, chunkDelayMs: 5 } })).id;
  await ensureApproved('model_provider', provider, tok.admin, platformChecker);
  ids.profile = (await call<{ id: string }>('POST', '/v1/model-profiles', tok.admin, { name: 'rw-support', providerId: provider, model: 'scripted-1', retries: 0 })).id;
  await ensureApproved('model_profile', ids.profile, tok.admin, platformChecker);

  // Two agents, taken live through the Head's approval.
  const agent = async (name: string, slug: string) => (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name, slug, purpose: name, conversationType: 'SUPPORT', modelProfileId: ids.profile, teamIds: [ids.team] })).id;
  ids.nila = await agent('Nila', 'nila-rw');
  ids.ethan = await agent('Ethan', 'ethan-rw');
  for (const a of [ids.nila, ids.ethan]) {
    const { proposal } = await call<{ proposal: { id: string; contentHash: string } }>('POST', `/v1/agents/${a}/status`, tok.lead, { status: 'LIVE', approval: { checkerId: ids.head, reason: 'E2E setup: ready' } });
    await call('POST', `/v1/approvals/${proposal.id}/decision`, tok.head, { decision: 'APPROVE', reason: 'E2E setup: reviewed', contentHash: proposal.contentHash });
  }

  // The web chat channel (a Tech makes it; a Head checks channels).
  const body = { kind: 'WEBCHAT', name: CHANNEL, settings: { branding: { title: 'Meridian languages' } }, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } };
  // Channels may be created only as drafts once their own approval kind exists: then the approval activates it.
  const res = await api.fetch('/v1/channels', { method: 'POST', headers: { authorization: `Bearer ${tok.admin}` }, data: { ...body, status: 'ACTIVE' } });
  const channel = (res.ok() ? await res.json() : await call('POST', '/v1/channels', tok.admin, { ...body, status: 'DRAFT' })) as { id: string; publicKey: string };
  ids.channel = channel.id;
  ids.key = channel.publicKey;
  await ensureApproved('channel', channel.id, tok.admin, { token: tok.head, id: ids.head });
});

test.afterAll(async () => {
  await api?.dispose();
});

async function submitModal(page: Page, reason: string): Promise<void> {
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(modal.getByLabel('checker')).toContainText(HEAD.name);
  await modal.getByLabel('checker').selectOption({ label: HEAD.name });
  await modal.getByLabel('reason').fill(reason);
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(modal).toBeHidden();
}

async function newQueue(page: Page, name: string, agent: string, value: string): Promise<void> {
  await page.getByRole('button', { name: 'New queue' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New queue' });
  await dialog.getByLabel('Queue name').fill(name);
  await dialog.getByLabel('AI agent').selectOption({ label: `${agent}` });
  await dialog.getByRole('button', { name: 'Add attribute' }).click();
  await dialog.getByLabel('Attribute 1 key').fill('rw_lang');
  await dialog.getByLabel('Attribute 1 value').fill(value);
  await dialog.getByRole('checkbox', { name: 'RW Language desk' }).check();
  await dialog.getByRole('button', { name: 'Create queue' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: `Created queue ${name}` })).toBeVisible();
}

test('a Lead builds two attribute queues and a language menu, and submits them for approval', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, LEAD);
  await page.goto('/queues');
  await newQueue(page, 'RW Tamil', 'Nila', 'ta');
  await newQueue(page, 'RW English', 'Ethan', 'en');
  const table = page.getByRole('table', { name: 'Queues' });
  for (const q of ['RW Tamil', 'RW English']) {
    await table.getByRole('button', { name: `Submit ${q} for approval` }).click();
    await submitModal(page, `New ${q} queue for the language menu`);
    await expect(table.getByRole('link', { name: `${q}: pending approval` })).toBeVisible();
  }

  // The router: a draft built in the UI.
  await page.goto('/routers');
  await expect(page.getByRole('heading', { name: 'Routers', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New router' }).first().click();
  const create = page.getByRole('dialog', { name: 'New router' });
  await create.getByLabel('Name').fill(ROUTER);
  await create.getByLabel('Fallback queue').selectOption({ label: 'RW English' });
  await create.getByRole('button', { name: 'Create router' }).click();
  await page.waitForURL(/\/routers\/[0-9a-f-]{36}$/);
  ids.router = page.url().split('/').pop()!;

  const draft = page.getByRole('region', { name: 'Router draft' });
  await draft.getByRole('button', { name: 'Add menu question' }).click();
  const step = draft.getByRole('region', { name: 'Step 1: Ask (menu)' });
  await step.getByLabel('Attribute').fill('rw_lang');
  await step.getByLabel('Question').fill('Choose a language / மொழியைத் தேர்ந்தெடுக்கவும்');
  await expect(step.getByLabel('Option 2 label')).toHaveValue('Tamil');
  await draft.getByRole('button', { name: 'Rules from queue attributes' }).click();
  await expect(draft.getByLabel('Rule 1 conditions')).toHaveValue('rw_lang=en');
  await expect(draft.getByLabel('Rule 2 conditions')).toHaveValue('rw_lang=ta');
  await expect(draft.getByLabel('Rule 2 queue')).toHaveValue(/.+/);
  await draft.getByRole('button', { name: 'Save draft' }).click();
  await expect(draft.getByText('Draft saved.')).toBeVisible();

  // The simulator: the Tamil answer lands in the Tamil queue — nothing is sent.
  const sim = page.getByRole('region', { name: 'Simulate' });
  await sim.getByLabel('Customer messages (one per line)').fill('vanakkam\nTamil');
  await sim.getByRole('button', { name: 'Run simulation' }).click();
  await expect(sim.getByRole('list', { name: 'Decision trace' })).toContainText('RW Tamil · Nila');

  // A draft router's channels attach directly (it routes nothing until approved).
  const channels = page.getByRole('region', { name: 'Channels' });
  await channels.getByRole('checkbox', { name: CHANNEL }).check();
  await channels.getByRole('button', { name: 'Save channels' }).click();
  await expect(page.locator('.rt-facts')).toContainText(CHANNEL);

  await draft.getByLabel('Version note').fill('English / Tamil menu');
  await draft.getByRole('button', { name: 'Save as new version' }).click();
  await expect(draft.getByText(/Saved as version 1/)).toBeVisible();
  const versions = page.getByRole('region', { name: 'Versions' });
  await versions.getByRole('button', { name: 'Activate v1' }).click();
  await submitModal(page, 'Language menu for web chat');
  await expect(page.getByRole('link', { name: /Pending approval · awaiting Harsh Approver/ })).toBeVisible();
  await logout(page);
});

test('a Head approves the queues and the router from the approvals queue', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, HEAD);
  await page.goto('/approvals');
  const table = page.getByRole('table', { name: 'Approvals' });
  for (const title of ['Approve queue RW Tamil', 'Approve queue RW English', `Activate router ${ROUTER} v1`]) {
    await table.getByRole('link', { name: new RegExp(title) }).click();
    const drawer = page.getByRole('dialog', { name: new RegExp(title) });
    await drawer.getByLabel('reason (required to reject)').fill('Reviewed for the language desk');
    await drawer.getByRole('button', { name: 'Approve' }).click();
    await expect(table.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  }
  await page.goto(`/routers/${ids.router}`);
  await expect(page.locator('.rt-facts')).toContainText('active');
  await expect(page.locator('.rt-facts')).toContainText('live v1');
  await logout(page);
});

test('a web chat customer who picks Tamil lands in the Tamil queue; the routing card says why', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const listed = await call<Array<{ id: string; status: string; router: { name: string; status: string } | null }>>('GET', '/v1/channels', tok.admin);
  expect(listed.find((c) => c.id === ids.channel)).toMatchObject({ status: 'ACTIVE', router: { name: ROUTER, status: 'ACTIVE' } });
  const visitor = await browser.newPage();
  await visitor.goto(`/chat/${ids.key}`);
  await expect(visitor.getByRole('heading', { name: 'Meridian languages' })).toBeVisible();
  const composer = visitor.getByRole('textbox', { name: 'Message' });
  await composer.fill('vanakkam, I need help');
  await composer.press('Enter');
  const log = visitor.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('Choose a language', { timeout: 30_000 });
  await visitor.getByRole('group', { name: 'Options' }).getByRole('button', { name: 'Tamil' }).click();
  await expect(log.locator('.wc-row.ai .wc-author').filter({ hasText: 'Nila' }).first()).toHaveText('Nila · AI assistant', { timeout: 30_000 });
  await visitor.close();

  const inbox = await call<{ items: Array<{ id: string; queue: { name: string } | null; channel: { name: string | null } }> }>('GET', '/v1/conversations?view=all', tok.lead);
  const conversation = inbox.items.find((c) => c.channel.name === CHANNEL);
  expect(conversation?.queue?.name).toBe('RW Tamil');

  await login(page, LEAD);
  await page.goto(`/conversations/${conversation!.id}`);
  const card = page.getByRole('region', { name: 'Routing' });
  await expect(card).toContainText(ROUTER);
  await expect(card).toContainText('matched a rule');
  await expect(card).toContainText('rw_lang=ta');
  await expect(card).toContainText('RW Tamil');
  // The inbox has a Routing filter for conversations a router is still deciding.
  await expect(page.getByRole('button', { name: /^Routing/ })).toBeVisible();

  // The agent's Channels tab is derived: reached through the router and the queue.
  await page.goto(`/agents/${ids.nila}?tab=channels`);
  const reach = page.getByRole('table', { name: 'Reached through' });
  await expect(reach).toContainText(CHANNEL);
  await expect(reach.getByRole('link', { name: ROUTER })).toBeVisible();
  await expect(reach).toContainText('RW Tamil');
  await logout(page);

  // The channel screen shows its router.
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await expect(page.getByRole('link', { name: new RegExp(ROUTER) })).toBeVisible();
});

test('a pass-through channel (no menu) answers straight away as its queue’s agent, once its router is approved', async ({ browser }) => {
  test.setTimeout(120_000);
  // The shape of the demo web chat and of every channel migrated from a default agent (0025): steps [], a fallback queue.
  const body = { kind: 'WEBCHAT', name: 'RW Direct chat', settings: { branding: { title: 'Meridian direct' } }, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } };
  const res = await api.fetch('/v1/channels', { method: 'POST', headers: { authorization: `Bearer ${tok.admin}` }, data: { ...body, status: 'ACTIVE' } });
  const channel = (res.ok() ? await res.json() : await call('POST', '/v1/channels', tok.admin, { ...body, status: 'DRAFT' })) as { id: string; publicKey: string };
  await ensureApproved('channel', channel.id, tok.admin, { token: tok.head, id: ids.head! });
  const english = (await call<Array<{ id: string; name: string }>>('GET', '/v1/queues', tok.lead)).find((q) => q.name === 'RW English')!;
  const router = await call<{ id: string }>('POST', '/v1/routers', tok.lead, { name: 'RW Direct', description: '', definition: { steps: [], rules: [], fallbackQueueId: english.id, returning: null, timeoutMinutes: 10 } });
  await call('PUT', `/v1/routers/${router.id}/channels`, tok.lead, { channelIds: [channel.id] });
  const version = await call<{ id: string }>('POST', `/v1/routers/${router.id}/versions`, tok.lead, { reason: 'Everyone to Ethan' });
  const { proposal } = await call<{ proposal: { id: string; contentHash: string } }>('POST', `/v1/routers/${router.id}/activate`, tok.lead, { versionId: version.id, approval: { checkerId: ids.head!, reason: 'Direct chat to Ethan' } });
  await call('POST', `/v1/approvals/${proposal.id}/decision`, tok.head, { decision: 'APPROVE', reason: 'Reviewed', contentHash: proposal.contentHash });

  const visitor = await browser.newPage();
  await visitor.goto(`/chat/${channel.publicKey}`);
  await expect(visitor.getByRole('heading', { name: 'Meridian direct' })).toBeVisible();
  const composer = visitor.getByRole('textbox', { name: 'Message' });
  await composer.fill('hello, my card is blocked');
  await composer.press('Enter');
  const log = visitor.getByRole('log', { name: 'Conversation' });
  await expect(log.locator('.wc-row.ai .wc-author').filter({ hasText: 'Ethan' }).first()).toHaveText('Ethan · AI assistant', { timeout: 30_000 });
  // No menu: the router asked nothing.
  await expect(visitor.getByRole('group', { name: 'Options' })).toHaveCount(0);
  await visitor.close();
});

test('approved: a queue change asks for a checker; disabling the router is immediate', async ({ page }) => {
  test.setTimeout(90_000);
  await login(page, LEAD);
  await page.goto('/queues');
  await page.getByRole('button', { name: 'Edit RW Tamil' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit RW Tamil' });
  await expect(dialog).toContainText('approved · changes need a checker');
  await dialog.getByLabel('Languages').fill('ta');
  await dialog.getByRole('button', { name: 'Submit change' }).click();
  await submitModal(page, 'Tamil speakers only');
  await expect(page.getByRole('status').filter({ hasText: /Sent “Change queue RW Tamil/ })).toBeVisible();

  await page.goto(`/routers/${ids.router}`);
  await page.getByRole('button', { name: 'Disable' }).click();
  await page.getByRole('dialog', { name: `Disable router ${ROUTER}` }).getByRole('button', { name: 'Disable router' }).click();
  await expect(page.locator('.rt-facts')).toContainText('disabled');
  await expect(page.getByRole('region', { name: 'Versions' }).getByRole('button', { name: 'Resume with v1' })).toBeVisible();
});
