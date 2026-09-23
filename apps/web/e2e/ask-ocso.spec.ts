import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { goLiveApproved } from './approval-setup';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { login, settled } from './helpers';
import { approvedProfile, approvedProvider } from './platform-setup';

/**
 * Ask OCSO as a copilot (PM/research/12) on the real stack, with the DEV_SCRIPTED model (API started with
 * OCSO_ENABLE_DEV_PROVIDERS=true). The scripted model calls exactly the tool a `[[call:<tool> {json}]]`
 * directive names, so each question drives the real meta tool `execute_tool` with a catalog capability: a
 * read runs at once; every write comes back as a server-built card and only the click runs it, through the
 * real API route as the user. Covered: a read, a direct write confirmed, a governed write submitted to a
 * checker, the checker approving it from Ask OCSO, a stop, and a refusal.
 *
 * The spec uses its own people (maker, checker, service member) so the other Ask OCSO spec's per-user thread
 * counts are untouched, and it puts the deployment's Ask OCSO model setting back the way it found it.
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const MAKER = { name: 'Ada Maker', email: `ada.maker.${RUN}@e2e.ocso.test`, password: 'correct-horse-battery-ada' };
const CHECKER = { name: 'Hana Checker', email: `hana.checker.${RUN}@e2e.ocso.test`, password: 'correct-horse-battery-hana' };
const SERVICE = { name: 'Sol Service', email: `sol.service.${RUN}@e2e.ocso.test`, password: 'correct-horse-battery-sol' };
const AGENT = `Orion ${RUN}`;
const NEW_AGENT = `Nova ${RUN}`;

const ids: { admin?: string; maker?: string; checker?: string; service?: string; team?: string; agent?: string; provider?: string; profile?: string; proposal?: string } = {};
const tok: { admin: string; maker: string; checker: string; service: string } = { admin: '', maker: '', checker: '', service: '' };
let api: APIRequestContext;
/** The deployment's Ask OCSO profile and writes switch before this spec: restored in afterAll. */
let previousProfile: string | null = null;
let previousWrites = true;
let writesTurnedOff = false;

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

const loginApi = async (email: string, password: string) => call<{ token: string; user: { id: string } }>('POST', '/v1/auth/login', null, { email, password });

function sqlValue(statement: string): string {
  return execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tAqc', statement], { stdio: 'pipe', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } })
    .toString()
    .trim();
}

/** A deployment-settings change is a proposal the maker (a Head, approvals.check.platform) approves. */
async function approvedSettings(patch: Record<string, unknown>): Promise<void> {
  const res = await call<{ proposal?: { id: string; contentHash: string } }>('PATCH', '/v1/settings/deployment', tok.admin, { ...patch, approval: { checkerId: ids.maker, reason: 'E2E: Ask OCSO cards' } });
  if (res.proposal) await call('POST', `/v1/approvals/${res.proposal.id}/decision`, tok.maker, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: res.proposal.contentHash });
}

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Ask OCSO' });
const log = (page: Page) => drawer(page).getByRole('log', { name: 'Ask OCSO conversation' });
const lastCard = (page: Page): Locator => log(page).getByRole('group').last();
const directive = (name: string, args: Record<string, unknown>) => `[[call:execute_tool ${JSON.stringify({ name, args })}]]`;

async function openDrawer(page: Page) {
  await settled(page);
  await page.keyboard.press('Control+j');
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByLabel('Ask about this deployment')).toBeEnabled();
}

/** Ask one question and wait until the answer has finished streaming. */
async function ask(page: Page, text: string) {
  const input = drawer(page).getByLabel('Ask about this deployment');
  await input.fill(text);
  await input.press('Enter');
  await expect(log(page)).toContainText(text.slice(0, 30));
  await expect(drawer(page).getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password });
  }
  const admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  tok.admin = admin.token;
  ids.admin = admin.user.id;

  ids.maker = (await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: MAKER.name, email: MAKER.email, role: 'HEAD', password: MAKER.password, teamIds: [], languages: [], maxConcurrent: 5 })).id;
  tok.maker = (await loginApi(MAKER.email, MAKER.password)).token;
  ids.team = (await call<{ id: string }>('POST', '/v1/teams', tok.maker, { name: `Ask OCSO owners ${RUN}` })).id;
  await call('PATCH', `/v1/users/${ids.maker}`, tok.admin, { teamIds: [ids.team] });
  ids.service = (await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: SERVICE.name, email: SERVICE.email, role: 'SERVICE', password: SERVICE.password, teamIds: [ids.team], languages: [], maxConcurrent: 5 })).id;
  tok.service = (await loginApi(SERVICE.email, SERVICE.password)).token;

  // The model: a scripted provider and profile, each a draft the maker (a Head) approves (PM/research/11 §4).
  const checkerForSetup = { id: ids.maker, token: tok.maker };
  ids.provider = await approvedProvider(api, tok.admin, checkerForSetup, { kind: 'DEV_SCRIPTED', name: `Scripted (ask-ocso ${RUN})`, settings: { latencyMs: 20, chunkDelayMs: 5 } });
  ids.profile = await approvedProfile(api, tok.admin, checkerForSetup, { name: `ask-ocso-cards-${RUN}`, providerId: ids.provider, model: 'scripted-1', retries: 0 });
  const settings = await call<{ internalAgentProfileId: string | null; askOcsoWrites?: boolean }>('GET', '/v1/settings/deployment', tok.admin);
  previousProfile = settings.internalAgentProfileId;
  previousWrites = settings.askOcsoWrites !== false;
  await approvedSettings({ internalAgentProfileId: ids.profile, ...(settings.askOcsoWrites === false ? { askOcsoWrites: true } : {}) });

  // A live agent owned by the maker's team; going live makes a second Head of that team, who checks its changes.
  const queue = (await call<{ id: string }>('POST', '/v1/queues', tok.maker, { name: `Ask OCSO queue ${RUN}`, teamIds: [ids.team] })).id;
  ids.agent = (await call<{ id: string }>('POST', '/v1/agents', tok.maker, { name: AGENT, purpose: 'card disputes', conversationType: 'SUPPORT', modelProfileId: ids.profile, defaultQueueId: queue, teamIds: [ids.team] })).id;
  const checker = await goLiveApproved(api, { adminToken: tok.admin, makerToken: tok.maker, agentId: ids.agent, ownerTeamId: ids.team, checker: CHECKER });
  ids.checker = checker.checkerId;
  tok.checker = checker.checkerToken;
});

test.afterAll(async () => {
  if (tok.admin && ids.maker) {
    await approvedSettings({ internalAgentProfileId: previousProfile, ...(writesTurnedOff || !previousWrites ? { askOcsoWrites: previousWrites } : {}) }).catch(() => {});
  }
  await api?.dispose();
});

test('a read answers straight away, with no card', async ({ page }) => {
  await login(page, MAKER);
  await openDrawer(page);
  // "What can you do?" is answered from the catalog for this role: no model call, no thread.
  const chips = drawer(page).getByRole('group', { name: 'Suggested questions' });
  await expect(chips.getByRole('button', { name: 'What is waiting on my approval?' }), 'the catalog chips have loaded').toBeVisible();
  await chips.getByRole('button', { name: 'What can you do?' }).click();
  const can = log(page).getByRole('note', { name: 'What Ask OCSO can do for you' });
  await expect(can).toContainText(/With your permissions I can use \d+ OCSO tools across \d+ areas\./);
  await expect(can.getByRole('row', { name: /Virtual agents/ })).toBeVisible();
  await expect(log(page).locator('.aturn.me')).toHaveCount(0);
  expect(Number(sqlValue(`SELECT count(*) FROM internal_agent_threads WHERE user_id = '${ids.maker}'`))).toBe(0);
  await ask(page, `Which agents do I have? ${directive('agents.list_agents', {})}`);
  await expect(log(page)).toContainText("Here's what I found.");
  await expect(log(page)).not.toContainText('did not go through');
  await expect(log(page).getByRole('group')).toHaveCount(0);
  expect(Number(sqlValue(`SELECT count(*) FROM internal_agent_actions WHERE user_id = '${ids.maker}'`))).toBe(0);
});

test('a direct write waits for the click, then applies through the real route as the user', async ({ page }) => {
  await login(page, MAKER);
  await openDrawer(page);
  await ask(page, `Create an agent called ${NEW_AGENT}. ${directive('agents.create_agent', { name: NEW_AGENT, conversationType: 'SUPPORT', teamIds: [ids.team] })}`);
  const card = lastCard(page);
  await expect(card).toContainText('Applies now');
  await expect(card).toContainText(NEW_AGENT);
  await expect(card).toContainText(`attributed to ${MAKER.name}`);
  // Nothing ran yet.
  const before = await call<Array<{ name: string }> | { rows: Array<{ name: string }> }>('GET', '/v1/agents', tok.maker);
  expect(JSON.stringify(before)).not.toContain(NEW_AGENT);

  await card.getByRole('button', { name: 'Confirm change' }).click();
  await expect(card.getByRole('status')).toContainText('done');
  await expect(card.getByRole('button', { name: 'Confirm change' })).toHaveCount(0);
  const after = await call<Array<{ id: string; name: string }> | { rows: Array<{ id: string; name: string }> }>('GET', '/v1/agents', tok.maker);
  const created = (Array.isArray(after) ? after : after.rows).find((a) => a.name === NEW_AGENT)?.id;
  expect(created, 'the agent exists after the click').toBeTruthy();
  const audit = await call<Array<{ via: string; actorId: string }>>('GET', `/v1/audit?targetId=${created}`, tok.admin);
  expect(audit).toContainEqual(expect.objectContaining({ via: 'INTERNAL_AGENT', actorId: ids.maker }));
});

test('a governed write is submitted to the checker the maker chooses', async ({ page }) => {
  await login(page, MAKER);
  await openDrawer(page);
  await ask(page, `Describe ${AGENT} as the card disputes agent. ${directive('agents.update_agent', { id: ids.agent, description: 'Handles card disputes end to end' })}`);
  const card = lastCard(page);
  await expect(card).toContainText('Needs approval');
  await expect(card).toContainText('Handles card disputes end to end');
  await expect(card.getByText(/approve it myself|bootstrap/i)).toHaveCount(0);
  const checker = card.getByLabel('Who approves');
  await expect(checker.locator('option', { hasText: CHECKER.name })).toHaveCount(1);
  await checker.selectOption((await checker.locator('option', { hasText: CHECKER.name }).getAttribute('value'))!);

  // The reason is required.
  await card.getByRole('button', { name: 'Send for approval' }).click();
  await expect(card.getByRole('alert')).toContainText('reason');
  await card.getByLabel('Reason').fill('Customers keep asking this agent about disputes');
  await card.getByRole('button', { name: 'Send for approval' }).click();
  await expect(card.getByRole('status')).toContainText('sent for approval');

  // Not applied: it waits on the checker.
  const agent = await call<{ description: string }>('GET', `/v1/agents/${ids.agent}`, tok.maker);
  expect(agent.description).not.toBe('Handles card disputes end to end');
  const waiting = await call<{ rows: Array<{ id: string; objectId: string; contentHash: string }> }>('GET', '/v1/approvals?box=AWAITING_ME', tok.checker);
  const proposal = waiting.rows.find((r) => r.objectId === ids.agent);
  expect(proposal, 'the proposal waits on the chosen checker').toBeTruthy();
  ids.proposal = proposal!.id;
});

test('the checker approves it from Ask OCSO, with the content hash they saw', async ({ page }) => {
  const proposal = await call<{ id: string; contentHash: string }>('GET', `/v1/approvals/${ids.proposal}`, tok.checker);
  await login(page, CHECKER);
  await openDrawer(page);
  await ask(page, `Approve the ${AGENT} change. ${directive('approvals.decide_approval', { id: proposal.id, decision: 'APPROVE', reason: 'Checked the description', contentHash: proposal.contentHash })}`);
  const card = lastCard(page);
  await expect(card).toBeVisible();
  // The checker reads the proposal's own diff on the card before approving (PM/research/12 §5).
  await expect(card.getByRole('row', { name: /^proposed · description/i })).toContainText('Handles card disputes end to end');
  // …and whose change it is.
  await expect(card.getByRole('row', { name: /^proposed by/i })).toContainText(MAKER.name);
  await expect(card).toContainText(`attributed to ${CHECKER.name}`);
  const confirm = card.getByRole('button', { name: /^Confirm/ });
  await confirm.click();
  await expect(card.getByRole('status')).toContainText('done');
  const agent = await call<{ description: string }>('GET', `/v1/agents/${ids.agent}`, tok.maker);
  expect(agent.description).toBe('Handles card disputes end to end');
});

test('a stop applies on confirm, without approval', async ({ page }) => {
  await login(page, MAKER);
  await openDrawer(page);
  await ask(page, `Pause ${AGENT} now. ${directive('agents.set_agent_status', { id: ids.agent, status: 'PAUSED' })}`);
  const card = lastCard(page);
  await expect(card).toHaveAttribute('data-kind', 'stop');
  await expect(card).toContainText('Stop');
  await expect(card.getByLabel('Who approves')).toHaveCount(0);
  await card.getByRole('button', { name: 'Confirm stop' }).click();
  await expect(card.getByRole('status')).toContainText('done');
  const agent = await call<{ status: string }>('GET', `/v1/agents/${ids.agent}`, tok.maker);
  expect(agent.status).toBe('PAUSED');
});

test('a service member asking for a platform change is refused: no card, nothing changes', async ({ page }) => {
  await login(page, SERVICE);
  await openDrawer(page);
  await ask(page, `Turn off the scripted provider. ${directive('models.update_provider', { id: ids.provider, enabled: false })}`);
  await expect(log(page).getByRole('note').filter({ hasText: 'Not available for your role: models · update provider.' })).toBeVisible();
  await expect(log(page).getByRole('group')).toHaveCount(0);
  expect(Number(sqlValue(`SELECT count(*) FROM internal_agent_actions WHERE user_id = '${ids.service}'`))).toBe(0);
  const provider = await call<{ enabled: boolean }>('GET', `/v1/model-providers/${ids.provider}`, tok.admin);
  expect(provider.enabled).toBe(true);
});

test('with writes turned off in Settings, Ask OCSO still answers but proposes no change', async ({ page }) => {
  // The Tech admin turns the switch off through the settings form; it is a proposal the maker approves.
  await page.goto('/settings');
  await page.waitForURL('**/login?next=%2Fsettings');
  await login(page, ACCOUNTS.admin, '/settings');
  const form = page.getByRole('form', { name: 'Ask OCSO' });
  const writes = form.getByRole('checkbox', { name: 'Let Ask OCSO propose changes' });
  await expect(writes).toBeChecked();
  await writes.uncheck();
  const checker = form.getByLabel('Checker');
  await expect(checker.locator('option', { hasText: MAKER.name })).toHaveCount(1);
  await checker.selectOption((await checker.locator('option', { hasText: MAKER.name }).getAttribute('value'))!);
  await form.getByLabel('Reason').fill('E2E: pause Ask OCSO changes');
  await form.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(form).toContainText(`Sent for approval to ${MAKER.name}`);
  writesTurnedOff = true;
  expect(sqlValue('SELECT ask_ocso_writes FROM deployment_settings LIMIT 1')).toBe('t');
  const waiting = await call<{ rows: Array<{ id: string; objectKind: string; contentHash: string }> }>('GET', '/v1/approvals?box=AWAITING_ME', tok.maker);
  const proposal = waiting.rows.find((r) => r.objectKind === 'deployment_settings');
  expect(proposal, 'the settings change waits on the maker').toBeTruthy();
  await call('POST', `/v1/approvals/${proposal!.id}/decision`, tok.maker, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: proposal!.contentHash });
  expect(sqlValue('SELECT ask_ocso_writes FROM deployment_settings LIMIT 1')).toBe('f');
  await page.reload();
  await expect(page.getByRole('form', { name: 'Ask OCSO' }).getByRole('checkbox', { name: 'Let Ask OCSO propose changes' })).not.toBeChecked();

  // A write is refused before any card; a read still answers.
  await page.context().clearCookies();
  await login(page, MAKER);
  await openDrawer(page);
  const cardsBefore = Number(sqlValue(`SELECT count(*) FROM internal_agent_actions WHERE user_id = '${ids.maker}'`));
  await ask(page, `Resume ${AGENT}. ${directive('agents.set_agent_status', { id: ids.agent, status: 'LIVE' })}`);
  await expect(log(page)).toContainText('Ask OCSO writes are turned off in this deployment');
  await expect(log(page).getByRole('group')).toHaveCount(0);
  expect(Number(sqlValue(`SELECT count(*) FROM internal_agent_actions WHERE user_id = '${ids.maker}'`))).toBe(cardsBefore);
  expect((await call<{ status: string }>('GET', `/v1/agents/${ids.agent}`, tok.maker)).status).toBe('PAUSED');
  await ask(page, `Which agents do I have? ${directive('agents.list_agents', {})}`);
  await expect(log(page)).toContainText(AGENT);
});
