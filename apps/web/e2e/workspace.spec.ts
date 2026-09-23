import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout } from './helpers';
import { routeChannelToAgent } from './routing';
import { goLiveApproved } from './approval-setup';
import { approveOver, approvedChannel, approvedProfile, approvedProvider } from './platform-setup';

/**
 * CS workspace (design/01) end to end against the real API + worker:
 * seeded through the API (setup → lead/exec → scripted model → agent → web
 * chat → queue), a customer talks to the AI over the public web-chat API and
 * asks for a human; the exec claims, replies, notes, tags (and filters the
 * inbox by tag), returns to AI and resolves in the browser. A second story confirms a sensitive action the AI
 * proposed through an MCP tool (examples/mcp-bank-demo, auth none).
 */
test.describe.configure({ mode: 'serial' });

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const LEAD = { name: 'Wes Lead', email: 'ws.lead@e2e.ocso.test', password: 'correct-horse-battery-wslead' };
const EXEC = { name: 'Esha Exec', email: 'ws.exec@e2e.ocso.test', password: 'correct-horse-battery-wsexec' };
const MCP_PORT = E2E.apiPort + 2;

let api: APIRequestContext;
let checker: { checkerId: string; checkerToken: string };
let mcp: ChildProcess | null = null;
const tok: Record<'admin' | 'lead' | 'exec', string> = { admin: '', lead: '', exec: '' };
const ids = { team: '', queue: '', provider: '', profile: '', agent: '', webchatKey: '', visitor: '', conversation: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, token: string | null, body?: unknown, ok: number[] = [200, 201, 204]): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (!ok.includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

async function visitor(): Promise<string> {
  return (await call<{ token: string }>('POST', `/public/webchat/${ids.webchatKey}/session`, null, {})).token;
}

async function say(visitorToken: string, text: string): Promise<string> {
  const res = await call<{ conversationId: string }>('POST', `/public/webchat/${ids.webchatKey}/messages`, visitorToken, { clientMessageId: `c-${randomBytes(6).toString('hex')}`, text });
  return res.conversationId;
}

type History = { messages: Array<{ from: string; parts: Array<{ text?: string }> }> };
const history = (visitorToken: string) => call<History>('GET', `/public/webchat/${ids.webchatKey}/messages`, visitorToken);
const historyText = async (visitorToken: string) => JSON.stringify((await history(visitorToken)).messages);

async function waitForState(conversationId: string, state: string): Promise<void> {
  await expect
    .poll(async () => (await call<{ controlState: string }>('GET', `/v1/conversations/${conversationId}`, tok.lead)).controlState, { timeout: 45_000, intervals: [500] })
    .toBe(state);
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(90_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });

  // First-run setup (or reuse it when another spec in this run already did it).
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const lead = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD.name, email: LEAD.email, role: 'HEAD', password: LEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  ids.team = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'WS Cards & EMI' })).id;
  // The lead manages the agent through an owning team of their own, outside the queue's team (ADR-026).
  const owners = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'WS Agent owners' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [owners] });
  // The exec's team is not one of the lead's, so the Tech admin creates them (a lead creates execs only into their own teams).
  await call('POST', '/v1/users', tok.admin, { name: EXEC.name, email: EXEC.email, role: 'SERVICE', password: EXEC.password, teamIds: [ids.team], languages: [], maxConcurrent: 5 });
  tok.exec = await loginApi(EXEC.email, EXEC.password);
  ids.queue = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'WS Cards & EMI · Tier 2', teamIds: [ids.team] })).id;

  // Deterministic development model (ADR-015) behind a real provider/profile.
  // Platform objects start as drafts: a Head approves enabling the provider and activating the channel (PM/research/11 §4).
  ids.provider = await approvedProvider(api, tok.admin, { id: lead.id, token: tok.lead }, { kind: 'DEV_SCRIPTED', name: 'WS Scripted', settings: { latencyMs: 50, chunkDelayMs: 15 } });
  ids.profile = await approvedProfile(api, tok.admin, { id: lead.id, token: tok.lead }, { name: 'ws-support', providerId: ids.provider, model: 'scripted-1', retries: 0 });
  ids.agent = (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name: 'Maya', slug: 'maya-ws', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: ids.profile, defaultQueueId: ids.queue, teamIds: [owners] })).id;
  // Going live is a maker–checker approval (PM/research/11 §4): a second Head of the owning team checks it.
  checker = await goLiveApproved(api, { adminToken: tok.admin, makerToken: tok.lead, agentId: ids.agent, ownerTeamId: owners, checker: { name: 'WS Checker', email: 'ws.checker@e2e.ocso.test', password: 'correct-horse-battery-wschecker' } });
  const channel = await approvedChannel<{ id: string; publicKey: string }>(api, tok.admin, { id: lead.id, token: tok.lead }, {
    kind: 'WEBCHAT',
    name: 'WS Web chat',
    // Visitors are simulated from Node (no Origin header), like a native app.
    settings: { auth: { allowNativeApps: true } },
    secrets: { visitorTokenSecret: randomBytes(32).toString('hex') },
  });
  ids.webchatKey = channel.publicKey;
  // channel → pass-through router → Maya's queue (PM/research/11 §5).
  routeChannelToAgent({ channelId: channel.id, agentId: ids.agent, queueId: ids.queue, name: 'WS Web chat' });
});

test.afterAll(async () => {
  mcp?.kill('SIGTERM');
  await api?.dispose();
});

test('a web-chat customer reaches the AI, then asks for a human', async () => {
  test.setTimeout(90_000);
  ids.visitor = await visitor();
  ids.conversation = await say(ids.visitor, 'My EMI was debited twice this month');
  await expect.poll(async () => (await history(ids.visitor)).messages.map((m) => m.from), { timeout: 45_000, intervals: [500] }).toContain('agent');
  await say(ids.visitor, 'I would like to talk to a human please');
  await waitForState(ids.conversation, 'WAITING_FOR_HUMAN');
});

test('Tech admin gets a clean forbidden state instead of conversation content', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto(`/conversations/${ids.conversation}`);
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByText('Conversation content is not available for your role')).toBeVisible();
  await expect(page.getByText('My EMI was debited twice')).toHaveCount(0);
  await logout(page);
});

test('the exec sees the escalation in pickup, claims it and sees the AI turns', async ({ page }) => {
  await login(page, EXEC);
  await page.goto('/conversations?view=waiting');
  const row = page.locator(`a.crow[data-conversation-id="${ids.conversation}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Waiting for human');
  await expect(page.getByRole('button', { name: /Waiting for human/ })).toHaveAttribute('aria-pressed', 'true');
  await row.click();
  await page.waitForURL(`**/conversations/${ids.conversation}**`);

  const timeline = page.getByRole('log', { name: 'Conversation timeline' });
  await expect(timeline.locator('.ev.cust').getByText('My EMI was debited twice this month', { exact: true })).toBeVisible();
  await expect(timeline.locator('.ev.ai').first()).toContainText('Maya');
  await expect(timeline.locator('.sysev.hi')).toContainText('escalation requested');
  await expect(page.locator('.takeover.wait')).toContainText('Maya asked for a human');
  await expect(page.locator('.locked')).toContainText('Claim this conversation to reply');

  await page.locator('.takeover').getByRole('button', { name: 'Claim conversation' }).click();
  await expect(page.locator('.takeover')).toContainText('You are handling this conversation.');
  await expect(page.locator('.chead .cstate')).toHaveText('You · human');
  await expect(timeline.getByText(/claimed by Esha Exec/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Assignment' })).toContainText('Esha Exec (you)');
});

test('the exec replies to the customer and the web chat receives it', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  const composer = page.getByLabel(/^Reply to /);
  await composer.fill('Hello, Esha here from the cards team. I can see both EMI debits and I am reversing one now.');
  await page.getByRole('button', { name: 'Send reply' }).click();
  const timeline = page.getByRole('log', { name: 'Conversation timeline' });
  await expect(timeline.locator('.ev.hum')).toContainText('I am reversing one now');
  await expect(timeline.locator('.ev.hum')).toContainText('human · you');
  await expect(composer).toHaveValue('');
  await expect.poll(() => historyText(ids.visitor), { timeout: 15_000 }).toContain('I am reversing one now');
});

test('an internal note stays internal', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  await page.getByRole('tab', { name: 'Internal note' }).click();
  await page.getByLabel('Internal note').fill('Duplicate terminal auth confirmed against the merchant batch file.');
  await page.getByLabel(/pass to Maya on return/).check();
  await page.getByRole('button', { name: 'Add note' }).click();
  const note = page.getByRole('log', { name: 'Conversation timeline' }).locator('.ev.note');
  await expect(note).toContainText('Duplicate terminal auth confirmed');
  await expect(note).toContainText('internal note · not sent to customer · passed to agent');
  expect(await historyText(ids.visitor)).not.toContain('Duplicate terminal auth');
});

test('the exec tags the conversation, filters the inbox by a tag and removes one', async ({ page }) => {
  const apiTags = async () => (await call<{ tags: string[] }>('GET', `/v1/conversations/${ids.conversation}`, tok.exec)).tags;
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  const card = page.getByRole('region', { name: 'Tags' });
  await expect(card).toContainText('No tags yet.');

  // Add three tags: normalized on the chip at once, then reconciled with what the API stored.
  await card.getByRole('button', { name: '+ tag' }).click();
  const input = card.getByRole('combobox', { name: 'Add tag' });
  for (const raw of ['  Duplicate   Debit ', 'EMI', 'merchant-terminal']) {
    await input.fill(raw);
    await input.press('Enter');
  }
  await expect(card.locator('.tagchip a')).toHaveText(['duplicate debit', 'emi', 'merchant-terminal']);
  await expect.poll(apiTags).toEqual(['duplicate debit', 'emi', 'merchant-terminal']);
  await input.fill('bad!tag');
  await input.press('Enter');
  await expect(card.getByRole('alert')).toContainText('1–40 characters');
  await input.press('Escape');
  await input.press('Escape');
  await expect(card.getByRole('button', { name: '+ tag' })).toBeVisible();
  const row = page.locator(`a.crow[data-conversation-id="${ids.conversation}"]`);
  await expect(row.locator('.rtags')).toContainText('duplicate debit');

  // Inbox tag filter with autocomplete from the tags in use.
  const filters = page.getByRole('group', { name: 'Views' });
  await filters.getByRole('button', { name: '+ tag' }).click();
  await filters.getByRole('combobox', { name: 'Filter by tag' }).fill('mer');
  await page.getByRole('option', { name: /^merchant-terminal/ }).click();
  await expect(filters.getByRole('button', { name: /Tag filter merchant-terminal/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/tag=merchant-terminal/);
  await expect(row).toBeVisible();
  await expect(row.locator('.rtags .chip.accent')).toHaveText('merchant-terminal');

  // ?tag= in the URL is honoured; a tag nobody uses shows an empty state that clears the filter.
  await page.goto(`/conversations/${ids.conversation}?tag=VIP`);
  await expect(filters.getByRole('button', { name: /Tag filter vip/ })).toBeVisible();
  await expect(page.getByText('No conversations tagged “vip” here')).toBeVisible();
  await page.getByRole('button', { name: 'Clear tag filter' }).click();
  await expect(row).toBeVisible();
  await expect(page).not.toHaveURL(/tag=/);

  // Remove a tag from the rail.
  await card.getByRole('button', { name: 'Remove tag emi' }).click();
  await expect(card.locator('.tagchip a')).toHaveText(['duplicate debit', 'merchant-terminal']);
  await expect.poll(apiTags).toEqual(['duplicate debit', 'merchant-terminal']);
  await page.reload();
  await expect(card.locator('.tagchip a')).toHaveText(['duplicate debit', 'merchant-terminal']);
});

test('a new customer message and a proactive copilot draft arrive live', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  const copilot = page.locator('.comp .copilot');
  await expect(copilot.getByRole('button', { name: 'Suggest a reply' })).toBeVisible();
  await expect(page.locator('.inbox')).toContainText('live');

  await say(ids.visitor, 'Thank you! When will the money reflect?');
  const timeline = page.getByRole('log', { name: 'Conversation timeline' });
  await expect(timeline.locator('.ev.cust').filter({ hasText: 'When will the money reflect?' })).toBeVisible({ timeout: 15_000 });
  await expect(copilot).toContainText('suggested reply', { timeout: 30_000 });
  await copilot.getByRole('button', { name: 'Dismiss' }).click();
  await expect(copilot.getByRole('button', { name: 'Suggest a reply' })).toBeVisible();
});

test('the copilot drafts a reply that is only inserted into the composer', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  const copilot = page.locator('.comp .copilot');
  await copilot.getByRole('button', { name: 'Suggest a reply' }).click();
  await expect(copilot.locator('.cb')).not.toBeEmpty({ timeout: 20_000 });
  await expect(copilot).toContainText('not sent until you send it');
  await copilot.getByRole('button', { name: 'Rewrite shorter' }).click();
  await expect(copilot.locator('.ch2')).toContainText('shorter', { timeout: 20_000 });
  await copilot.getByRole('button', { name: 'Insert' }).click();
  await expect(page.getByLabel(/^Reply to /)).not.toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled();
  // Nothing was sent: the customer still has only one human message.
  expect((await history(ids.visitor)).messages.filter((m) => m.from === 'human')).toHaveLength(1);
});

test('the exec returns control to the AI, cancels, and resolves', async ({ page }) => {
  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  await page.locator('.takeover').getByRole('button', { name: 'Return to AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Return to Maya' });
  await dialog.getByLabel('Handover summary').fill('Reversal raised for the duplicate EMI debit; customer informed.');
  await dialog.getByRole('button', { name: 'Return to AI' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.takeover.ret')).toContainText('Maya resumes on the next customer message');
  await expect(page.locator('.takeover.ret')).toContainText('1 internal note');
  await expect(page.locator('.locked')).toContainText('Control is going back to Maya');
  await waitForState(ids.conversation, 'AI_RESUMING');

  await page.locator('.takeover').getByRole('button', { name: 'Cancel return' }).click();
  await expect(page.locator('.takeover')).toContainText('You are handling this conversation.');

  await page.locator('.takeover').getByRole('button', { name: 'Resolve' }).click();
  const resolve = page.getByRole('dialog', { name: 'Resolve conversation' });
  await resolve.getByLabel(/Disposition/).fill('duplicate debit reversed');
  const resolveTag = resolve.getByRole('combobox', { name: 'Add tag on resolve' });
  await resolveTag.fill('Reversal Done');
  await resolveTag.press('Enter');
  await expect(resolve.getByRole('group', { name: 'Tags after resolving' })).toContainText('reversal done');
  await resolve.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.takeover.resolved')).toContainText('Resolved by Esha Exec · duplicate debit reversed');
  await expect(page.locator('.locked').getByRole('button', { name: 'Reopen' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tags' }).locator('.tagchip a')).toHaveText(['duplicate debit', 'merchant-terminal', 'reversal done']);
  await waitForState(ids.conversation, 'RESOLVED');
  await page.getByRole('button', { name: /^Resolved/ }).click();
  await expect(page.locator(`a.crow[data-conversation-id="${ids.conversation}"]`)).toContainText('Resolved');
});

test('a sensitive action the AI proposed is confirmed from the timeline', async ({ page }) => {
  test.setTimeout(120_000);
  mcp = startMeridianDemo();
  await expect.poll(async () => (await fetch(`http://127.0.0.1:${MCP_PORT}/healthz`).then((r) => r.status).catch(() => 0)), { timeout: 20_000 }).toBe(200);

  // Tech admin connects the external MCP server and classifies the policy search as sensitive.
  // Settings and MCP connections change through approvals (PM/research/11 §4): the second Head checks them.
  const platformChecker = { id: checker.checkerId, token: checker.checkerToken };
  const current = await call<{ egressAllowedInternalHosts: string[] }>('GET', '/v1/settings/deployment', tok.admin);
  if (!current.egressAllowedInternalHosts.includes('127.0.0.1')) {
    await approveOver(api, tok.admin, platformChecker, { method: 'PATCH', path: '/v1/settings/deployment', body: { egressAllowedInternalHosts: [...current.egressAllowedInternalHosts, '127.0.0.1'] } });
  }
  const conn = await call<{ id: string }>('POST', '/v1/mcp/connections', tok.admin, { name: 'refund-desk', url: `http://127.0.0.1:${MCP_PORT}/mcp`, network: 'INTERNAL' });
  await call('POST', `/v1/mcp/connections/${conn.id}/discover`, tok.admin);
  const tools = await call<Array<{ id: string; name: string }>>('GET', `/v1/mcp/connections/${conn.id}/tools`, tok.admin);
  const search = tools.find((t) => t.name === 'knowledge.search_policy');
  expect(search, 'demo server exposes knowledge.search_policy').toBeTruthy();
  await call('PUT', `/v1/mcp/connections/${conn.id}/tools`, tok.admin, { tools: [{ toolId: search!.id, riskClass: 'SENSITIVE', approved: true }] });
  await approveOver(api, tok.admin, platformChecker, { method: 'POST', path: `/v1/mcp/connections/${conn.id}/approve`, body: { allowedAgentIds: [ids.agent] } });
  // Activation is deferred: the worker re-contacts the server, then the connection is live.
  await expect.poll(async () => (await call<{ status: string }>('GET', `/v1/mcp/connections/${conn.id}`, tok.admin)).status, { timeout: 30_000 }).toBe('ACTIVE');
  // Maya is live: granting her a tool is an agent_tool_grant proposal the second Head approves (PM/research/11 §4).
  const grant = await call<{ proposal: { id: string; contentHash: string } }>('PUT', `/v1/agents/${ids.agent}/tools`, tok.lead, { grants: [{ toolId: search!.id }], approval: { checkerId: checker.checkerId, reason: 'E2E: the refund desk policy search' } }, [202]);
  await call('POST', `/v1/approvals/${grant.proposal.id}/decision`, checker.checkerToken, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: grant.proposal.contentHash });

  // The scripted model calls the tool on "refund"; policy holds it for a human and escalates.
  const customer = await visitor();
  const conversationId = await say(customer, 'I need a refund of the card fee');
  await waitForState(conversationId, 'WAITING_FOR_HUMAN');

  await login(page, EXEC);
  await page.goto(`/conversations/${conversationId}`);
  const card = page.getByRole('group', { name: 'Confirm Search bank policies' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Maya proposed this action');
  await expect(card).toContainText('refund-desk');
  await expect(card).toContainText('query');
  await expect(card).toContainText(/expires in \d\d:\d\d/);
  await page.locator('.takeover').getByRole('button', { name: 'Claim conversation' }).click();
  await expect(page.locator('.takeover')).toContainText('You are handling this conversation.');

  await card.getByRole('button', { name: 'Confirm and run' }).click();
  await expect(card).toBeHidden({ timeout: 30_000 });
  const done = page.locator('.toolev').filter({ hasText: 'Search bank policies' }).filter({ hasText: 'confirmed by Esha Exec' });
  await expect(done).toContainText('ok');
  await expect(done).toContainText('results');

  // The same tool from the composer: schema form → explicit confirm step → run as the exec.
  await page.getByRole('tab', { name: 'Tool action' }).click();
  await page.getByRole('button', { name: /Search bank policies/ }).click();
  await page.getByLabel('Query').fill('fee waiver');
  await page.getByRole('button', { name: 'Review and confirm' }).click();
  await expect(page.locator('.comp .confirm')).toContainText('confirm sensitive action');
  await page.locator('.comp .confirm').getByRole('button', { name: 'Confirm and run' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Search bank policies succeeded' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.toolev').filter({ hasText: 'run by a human' })).toContainText('ok');
});

test('leaving the workspace restores the page padding of the next screen', async ({ page }) => {
  // Next keeps the previous route's subtree as a display:none child; a `:has(> .ws)` rule on the shell
  // matched it and left every later screen flush against the sidebar.
  await login(page, EXEC);
  const padding = () => page.locator('#main').evaluate((el) => getComputedStyle(el).paddingTop);
  await page.goto('/conversations');
  await expect(page.getByRole('heading', { name: 'Conversations' })).toBeVisible();
  await expect(page.locator('main > .ws')).toHaveCount(1);
  expect(await page.locator('main > .ws').evaluate((el) => el.getBoundingClientRect().top)).toBe(0);
  await page.locator('a[href^="/customers"]').first().click();
  await page.waitForURL('**/customers');
  await expect(page.getByRole('heading', { name: 'Customers' }).first()).toBeVisible();
  expect(await padding()).not.toBe('0px');
  await logout(page);
});

function startMeridianDemo(): ChildProcess {
  const demo = join(repo, 'examples/mcp-bank-demo');
  if (!existsSync(join(demo, 'dist/main.js'))) execFileSync(join(repo, 'node_modules/.bin/tsc'), ['-p', join(demo, 'tsconfig.build.json')], { stdio: 'inherit' });
  return spawn(process.execPath, [join(demo, 'dist/main.js')], {
    env: { ...process.env, PORT: String(MCP_PORT), HOST: '127.0.0.1', DEMO_MCP_AUTH: 'none' },
    stdio: process.env['E2E_VERBOSE'] === '1' ? 'inherit' : 'ignore',
  });
}
