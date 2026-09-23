import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { login, logout, settled } from './helpers';
import { approvedProfile, approvedProvider, userIdOf } from './platform-setup';

/**
 * Ask OCSO (design/05, docs/12) on the real stack with the DEV_SCRIPTED model
 * (API started with OCSO_ENABLE_DEV_PROVIDERS=true): setup, streaming, stop,
 * threads, and proposals stored before confirmation cards (seeded the way the
 * earlier agent stored them). Cards end to end — read, direct write, governed
 * write, checker approval, stop, refusal — are in ask-ocso.spec.ts.
 */
test.describe.configure({ mode: 'serial' });

const PROFILE = 'ask-ocso-e2e';
const ids: { admin?: string; lead?: string; exec?: string; profile?: string; agent?: string } = {};
const tokens: Record<'admin' | 'lead' | 'exec', string> = { admin: '', lead: '', exec: '' };
let api: APIRequestContext;

const auth = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Ask OCSO' });
const log = (page: Page) => drawer(page).getByRole('log', { name: 'Ask OCSO conversation' });

async function signIn(who: keyof typeof tokens): Promise<void> {
  const res = await api.post('/v1/auth/login', { data: { email: ACCOUNTS[who].email, password: ACCOUNTS[who].password } });
  expect(res.ok(), `login ${who}`).toBe(true);
  const body = await res.json();
  tokens[who] = body.token;
  ids[who] = body.user.id;
}

function sql(statement: string): void {
  execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-qc', statement], { stdio: 'pipe', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } });
}

/** A pending proposal in a thread of `userId`, stored as the agent loop stores it (packages/internal-agent). */
function seedProposal(userId: string, title: string, action: { tool: string; params: object; description: string; changes: object[] }, extraParts: object[] = []) {
  const thread = randomUUID();
  const actionId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const pending = { id: actionId, tool: action.tool, risk: 'HIGH_WRITE', description: action.description, expiresAt, changes: action.changes };
  const parts = [{ type: 'text', text: 'Nothing changes until you confirm.' }, { type: 'action', action: pending }, { type: 'tool', name: action.tool, args: action.params, ok: true }, ...extraParts];
  const json = (v: unknown) => `$j$${JSON.stringify(v)}$j$::jsonb`;
  sql(`
    INSERT INTO internal_agent_threads (id, user_id, title) VALUES ('${thread}', '${userId}', $t$${title}$t$);
    INSERT INTO internal_agent_messages (id, thread_id, role, parts, created_at) VALUES
      ('${randomUUID()}', '${thread}', 'user', ${json([{ type: 'text', text: title }])}, now() - interval '2 seconds'),
      ('${randomUUID()}', '${thread}', 'assistant', ${json(parts)}, now() - interval '1 second');
    INSERT INTO internal_agent_actions (id, thread_id, user_id, tool, params, risk, description, expires_at)
      VALUES ('${actionId}', '${thread}', '${userId}', '${action.tool}', ${json(action.params)}, 'HIGH_WRITE', $d$${action.description}$d$, '${expiresAt}');
  `);
  return { thread, actionId };
}

async function openDrawer(page: Page) {
  await settled(page);
  await page.keyboard.press('Control+j');
  await expect(drawer(page)).toBeVisible();
}

async function openThread(page: Page, title: string) {
  await drawer(page).getByRole('button', { name: 'Conversation history' }).click();
  await drawer(page).getByRole('region', { name: 'Conversation history' }).getByRole('button', { name: new RegExp(title) }).click();
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await (await api.get('/v1/setup/status')).json();
  if (status.setupRequired) {
    const setup = { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password };
    expect((await api.post('/v1/setup', { data: setup })).status()).toBe(201);
  }
  await signIn('admin');
  for (const [who, role] of [['lead', 'HEAD'], ['exec', 'SERVICE']] as const) {
    const res = await api.post('/v1/users', { headers: auth('admin'), data: { email: ACCOUNTS[who].email, name: ACCOUNTS[who].name, role, password: ACCOUNTS[who].password } });
    expect([201, 409], `create ${who}`).toContain(res.status());
    await signIn(who);
  }
  const kinds = await (await api.get('/v1/model-providers/kinds', { headers: auth('admin') })).json();
  expect(kinds.map((k: { kind: string }) => k.kind), 'start the API with OCSO_ENABLE_DEV_PROVIDERS=true').toContain('DEV_SCRIPTED');
  // Slow enough that streaming is observable: ~45 words × 80 ms.
  // A provider is a disabled draft until a Head approves enabling it (PM/research/11 §4).
  const providerId = await approvedProvider(api, tokens.admin, { id: await userIdOf(api, tokens.lead), token: tokens.lead }, { kind: 'DEV_SCRIPTED', name: 'Scripted (e2e)', settings: { latencyMs: 150, chunkDelayMs: 80 } });
  // The internal agent uses only a model profile a platform checker approved.
  ids.profile = await approvedProfile(api, tokens.admin, { id: await userIdOf(api, tokens.lead), token: tokens.lead }, { name: PROFILE, providerId, model: 'scripted-1', retries: 0 });
  // Agents belong to teams (ADR-026): the lead joins a team that owns Maya.
  const teams: Array<{ id: string; name: string }> = await (await api.get('/v1/teams', { headers: auth('lead') })).json();
  const teamId = teams.find((t) => t.name === 'IA Owners')?.id ?? (await (await api.post('/v1/teams', { headers: auth('lead'), data: { name: 'IA Owners' } })).json()).id;
  expect((await api.patch(`/v1/users/${ids.lead}`, { headers: auth('admin'), data: { teamIds: [teamId] } })).ok()).toBe(true);
  const agent = await api.post('/v1/agents', { headers: auth('lead'), data: { name: 'Maya', conversationType: 'SUPPORT', teamIds: [teamId] } });
  expect(agent.status()).toBe(201);
  ids.agent = (await agent.json()).id;
});

test.afterAll(async () => {
  await api?.dispose();
});

test('without a model profile nothing is sent, and only a Tech admin can choose one', async ({ page }) => {
  await login(page, ACCOUNTS.exec);
  await openDrawer(page);
  await expect(drawer(page)).toContainText('Ask OCSO is not set up yet.');
  await expect(drawer(page)).toContainText('a Tech admin chooses');
  await expect(drawer(page).getByLabel('Model profile for Ask OCSO')).toHaveCount(0);
  await expect(drawer(page).getByLabel('Ask about this deployment')).toBeDisabled();
  // The API refuses before streaming, with a code the drawer turns into this state.
  const chat = await api.post('/v1/internal-agent/chat', { headers: auth('exec'), data: { message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } } });
  expect(chat.status()).toBe(400);
  expect((await chat.json()).error.code).toBe('internal_agent_not_configured');
  await logout(page);

  await login(page, ACCOUNTS.admin);
  await openDrawer(page);
  await expect(drawer(page)).toContainText('Ask OCSO is not set up yet.');
  const picker = drawer(page).getByLabel('Model profile for Ask OCSO');
  await expect(picker.locator('option')).toContainText([`${PROFILE} · scripted-1 · Scripted (e2e)`]);
  await picker.selectOption({ label: `${PROFILE} · scripted-1 · Scripted (e2e)` });
  // A deployment setting: choosing it is a proposal a second person (the lead, a Head) approves (PM/research/11 §4).
  await drawer(page).getByRole('button', { name: 'Use this profile' }).click();
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await expect(modal).toBeVisible();
  await modal.getByLabel('checker').selectOption({ label: ACCOUNTS.lead.name });
  await modal.getByLabel('reason').fill('Ask OCSO for everyone');
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(drawer(page).getByText(/Sent for approval/)).toBeVisible();
  expect((await (await api.get('/v1/settings/deployment', { headers: auth('admin') })).json()).internalAgentProfileId).toBeNull();
  const open = (await (await api.get('/v1/approvals?box=AWAITING_ME', { headers: auth('lead') })).json()) as { rows: Array<{ id: string; objectKind: string; contentHash: string }> };
  const proposal = open.rows.find((r) => r.objectKind === 'deployment_settings')!;
  expect((await api.post(`/v1/approvals/${proposal.id}/decision`, { headers: auth('lead'), data: { decision: 'APPROVE', reason: 'ok', contentHash: proposal.contentHash } })).ok()).toBe(true);
  const settings = await (await api.get('/v1/settings/deployment', { headers: auth('admin') })).json();
  expect(settings.internalAgentProfileId).toBe(ids.profile);
  await page.reload();
  await openDrawer(page);
  await expect(drawer(page).getByText('Ask OCSO is not set up yet.')).toBeHidden();
  await expect(drawer(page).getByLabel('Ask about this deployment')).toBeEnabled();
});

test('Lead gets a streamed answer, can stop one, and the thread is kept', async ({ page }) => {
  await login(page, ACCOUNTS.lead);
  await settled(page);
  await page.getByRole('button', { name: /Ask OCSO/ }).first().click();
  await expect(drawer(page)).toContainText("scope · your teams' virtual agents and business operations");
  await expect(drawer(page)).toContainText('role: head');
  await expect(drawer(page)).toContainText('context · home');

  const input = drawer(page).getByLabel('Ask about this deployment');
  await input.fill('How are the queues doing today?');
  await input.press('Enter');
  await expect(log(page)).toContainText('How are the queues doing today?');
  // Streaming: the start of the answer is on screen while the rest is still coming.
  const stop = drawer(page).getByRole('button', { name: 'Stop' });
  await expect(stop).toBeVisible();
  await expect(log(page)).toContainText('Thanks for reaching out!');
  expect(await log(page).textContent()).not.toContain('ask for a human');
  await expect(log(page)).toContainText('You said: "How are the queues doing today?"');
  // The scripted reply ends with its closing parenthesis once fully streamed.
  await expect(log(page)).toContainText('{json}]].)', { timeout: 15_000 });
  await expect(stop).toBeHidden();

  // Same thread for the follow-up (history lists one conversation).
  await input.fill('And which agent needs attention?');
  await input.press('Enter');
  await expect(log(page)).toContainText('You said: "And which agent needs attention?"', { timeout: 15_000 });
  await expect(stop).toBeHidden({ timeout: 15_000 });

  // Stop mid-answer: the partial text stays, marked incomplete.
  await input.fill('One more question to interrupt');
  await input.press('Enter');
  await expect(log(page)).toContainText('Thanks for reaching out! You said: "One more');
  await stop.click();
  await expect(log(page)).toContainText('Stopped. The answer above is incomplete.');
  await expect(drawer(page).getByRole('button', { name: 'Send' })).toBeVisible();

  // Esc closes; ⌘J/Ctrl+J reopens with the conversation intact.
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await page.keyboard.press('Control+j');
  await expect(log(page)).toContainText('And which agent needs attention?');

  await drawer(page).getByRole('button', { name: 'New conversation' }).first().click();
  await expect(log(page)).not.toContainText('How are the queues doing today?');
  await drawer(page).getByRole('button', { name: 'Conversation history' }).click();
  const history = drawer(page).getByRole('region', { name: 'Conversation history' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await history.getByRole('button', { name: /How are the queues doing today\?/ }).click();
  await expect(log(page)).toContainText('How are the queues doing today?');
  await expect(log(page)).toContainText('You said: "And which agent needs attention?"');
});

test('A proposal from before confirmation cards stays readable in history but can no longer run', async ({ page }) => {
  const title = 'Pause Maya for now';
  seedProposal(ids.lead!, title, {
    tool: 'set_agent_status',
    params: { agentId: ids.agent, status: 'PAUSED' },
    description: 'Pause Maya. New customer messages will wait for humans.',
    changes: [{ label: 'Maya · status', before: 'DRAFT', after: 'PAUSED' }],
  });
  await login(page, ACCOUNTS.lead);
  await openDrawer(page);
  await openThread(page, title);

  const card = log(page).getByRole('group', { name: 'Pause Maya. New customer messages will wait for humans.' });
  await expect(log(page)).toContainText('1 step · set agent status');
  await expect(card).toContainText('confirm change');
  await expect(card.getByRole('table')).toContainText('Maya · status');
  await expect(card.getByRole('row', { name: /Maya · status/ })).toContainText('DRAFT');
  await expect(card.getByRole('row', { name: /Maya · status/ })).toContainText('PAUSED');
  await expect(card).toContainText(`attributed to ${ACCOUNTS.lead.name}`);
  // Earlier proposals carry no server-built card (PM/research/12 §5): the API refuses to run them.
  await card.getByRole('button', { name: 'Confirm change' }).click();
  await expect(card.getByRole('status')).toContainText('earlier version of Ask OCSO');
  await expect(card.getByRole('button', { name: 'Confirm change' })).toHaveCount(0);
  const agent = await (await api.get(`/v1/agents/${ids.agent}`, { headers: auth('lead') })).json();
  expect(agent.status).toBe('DRAFT');
});

test('Threads are per user, refusals read plainly, and an earlier proposal does nothing for anyone', async ({ page }) => {
  const title = 'Put Maya live';
  seedProposal(
    ids.exec!,
    title,
    { tool: 'set_agent_status', params: { agentId: ids.agent, status: 'LIVE' }, description: 'Put Maya live.', changes: [{ label: 'Maya · status', before: 'DRAFT', after: 'LIVE' }] },
    [{ type: 'denied', text: 'Not available for your role: latency breakdown.' }],
  );
  await login(page, ACCOUNTS.exec);
  await openDrawer(page);
  await drawer(page).getByRole('button', { name: 'Conversation history' }).click();
  // Threads are per user: the lead's conversations are not listed.
  const history = drawer(page).getByRole('region', { name: 'Conversation history' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await history.getByRole('button', { name: new RegExp(title) }).click();

  await expect(drawer(page).getByRole('note')).toContainText('Not available for your role: latency breakdown.');
  const card = log(page).getByRole('group', { name: 'Put Maya live.' });
  await card.getByRole('button', { name: 'Confirm change' }).click();
  await expect(card.getByRole('status')).toContainText('earlier version of Ask OCSO');
  const agent = await (await api.get(`/v1/agents/${ids.agent}`, { headers: auth('lead') })).json();
  expect(agent.status).toBe('DRAFT');
});
