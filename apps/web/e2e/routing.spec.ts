import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { activateRouter } from './routing';
import { approvedChannel, approvedProfile, approvedProvider } from './platform-setup';

/**
 * A menu router in front of two agents (PM/research/11 §5): the web chat
 * visitor is asked what they need (buttons), taps one, and the chosen queue's
 * agent answers — routed by the worker's conversation.route consumer.
 * Router and queues are set up through the real API; only the approval step
 * (activation) is done in SQL.
 */
test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
const LEAD = { name: 'Rhea Router', email: 'rt.lead@e2e.ocso.test', password: 'correct-horse-battery-rtlead' };
const tok = { admin: '', lead: '' };
const ids = { key: '', router: '', cards: '', loans: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, token: string | null, body?: unknown, ok: number[] = [200, 201, 202, 204]): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (!ok.includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;
const log = (page: Page) => page.getByRole('log', { name: 'Conversation' });

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
  const team = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'RT Service' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [team] });
  // Platform objects start as drafts: a Head approves enabling the provider and activating the channel (PM/research/11 §4).
  const provider = await approvedProvider(api, tok.admin, { id: lead.id, token: tok.lead }, { kind: 'DEV_SCRIPTED', name: 'RT Scripted', settings: { latencyMs: 20, chunkDelayMs: 5 } });
  const profile = await approvedProfile(api, tok.admin, { id: lead.id, token: tok.lead }, { name: 'rt-support', providerId: provider, model: 'scripted-1', retries: 0 });
  const agent = async (name: string, slug: string, type: string) =>
    (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name, slug, purpose: name, conversationType: type, modelProfileId: profile, teamIds: [team] })).id;
  const [nila, kabir] = [await agent('Nila', 'nila-rt', 'SUPPORT'), await agent('Kabir', 'kabir-rt', 'SALES')];
  // Going live is an approval (PM/research/11 §4) exercised by the approvals specs; here the agents are simply live.
  execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-qc', `UPDATE virtual_agents SET status = 'LIVE' WHERE id IN ('${nila}', '${kabir}')`], { stdio: 'pipe' });

  // Queues are the service unit: one agent each, with attributes.
  ids.cards = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'RT Cards', teamIds: [team] })).id;
  ids.loans = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'RT Loans', teamIds: [team] })).id;
  await call('PATCH', `/v1/queues/${ids.cards}`, tok.lead, { agentId: nila, attributes: { product: 'cards' } });
  await call('PATCH', `/v1/queues/${ids.loans}`, tok.lead, { agentId: kabir, attributes: { product: 'loans' } });

  const channel = await approvedChannel<{ id: string; publicKey: string }>(api, tok.admin, { id: lead.id, token: tok.lead }, {
    kind: 'WEBCHAT',
    name: 'RT Menu chat',
    settings: { branding: { title: 'Meridian help' } },
    secrets: { visitorTokenSecret: randomBytes(32).toString('hex') },
  });
  ids.key = channel.publicKey;

  const router = await call<{ id: string }>('POST', '/v1/routers', tok.lead, {
    name: 'RT Menu',
    definition: {
      steps: [
        {
          id: 'product',
          kind: 'ASK',
          attribute: 'product',
          prompt: { text: 'Hi! What can we help you with?' },
          options: [
            { value: 'cards', label: 'Cards & EMI' },
            { value: 'loans', label: 'Loans' },
          ],
          maxAttempts: 2,
          skipIfKnown: false,
        },
      ],
      rules: [{ when: { product: 'loans' }, queueId: ids.loans }],
      fallbackQueueId: ids.cards,
      returning: null,
      timeoutMinutes: 10,
    },
  });
  ids.router = router.id;
  const version = await call<{ id: string }>('POST', `/v1/routers/${router.id}/versions`, tok.lead, { reason: 'E2E menu' });
  // Activation and channel attachment are approvals over HTTP (409 until wave 2 wires them).
  await call('POST', `/v1/routers/${router.id}/activate`, tok.lead, { versionId: version.id }, [409]);
  activateRouter(router.id, version.id, [channel.id]);
});

test.afterAll(async () => {
  await api?.dispose();
});

test('the simulator shows the menu decision without sending anything', async () => {
  const sim = await call<{ decision: { queueName: string; agentName: string; outcome: string } }>('POST', `/v1/routers/${ids.router}/simulate`, tok.lead, { messages: ['hi', '2'] });
  expect(sim.decision).toMatchObject({ queueName: 'RT Loans', agentName: 'Kabir', outcome: 'RULE' });
});

test('a web chat visitor answers the menu with a button and the chosen agent replies', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`/chat/${ids.key}`);
  await expect(page.getByRole('heading', { name: 'Meridian help' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill('hello, I need some help');
  await composer.press('Enter');

  // The router asks, with one button per option.
  const options = page.getByRole('group', { name: 'Options' });
  await expect(log(page)).toContainText('Hi! What can we help you with?', { timeout: 30_000 });
  await expect(options.getByRole('button', { name: 'Loans' })).toBeEnabled();
  await options.getByRole('button', { name: 'Loans' }).click();

  // The tap is the customer's answer; the Loans queue's agent (Kabir) now answers everything they wrote.
  await expect(log(page).locator('.wc-row.me').last()).toContainText('Loans');
  const reply = log(page).locator('.wc-row.ai').last();
  await expect(reply).toContainText('You said:', { timeout: 30_000 });
  await expect(log(page).locator('.wc-row.ai .wc-author').filter({ hasText: 'Kabir' }).first()).toHaveText('Kabir · AI assistant');
  // The old question's buttons are history now.
  await expect(options.getByRole('button', { name: 'Loans' })).toBeDisabled();

  const inbox = await call<{ items: Array<{ agent: { name: string } | null; queue: { name: string } | null; channel: { name: string | null } }> }>('GET', '/v1/conversations?view=ai', tok.lead);
  expect(inbox.items.find((c) => c.channel.name === 'RT Menu chat')).toMatchObject({ agent: { name: 'Kabir' }, queue: { name: 'RT Loans' } });
});
