import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { login, logout } from './helpers';
import { approveOver, approvedChannel, approvedProfile, approvedProvider } from './platform-setup';
import { routeChannelToAgent } from './routing';

/**
 * Message templates end to end (docs/archive/specs/07 §3, docs/archive/specs/09 §4) on a WhatsApp
 * (Twilio) channel, against the real API + worker and a local Twilio
 * stand-in (Messages + Content API) the channel points at: a WhatsApp
 * customer writes, the exec holds the conversation after the adapter's
 * 24-hour window, the composer switches to Template, the exec fills and
 * sends an approved template (delivered through Twilio by Content SID); a
 * Head writes a template and submits it — a second Head approves the
 * submission in Approvals (PM/research/11 §4), only then does the worker send
 * it to WhatsApp — and the maker is notified in-app when WhatsApp approves it.
 * The old /whatsapp-templates URL redirects.
 */
test.describe.configure({ mode: 'serial' });

const ACCOUNT_SID = 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90';
const AUTH_TOKEN = '3f9c2b7a1e8d4c6b0a5f9e2d7c1b8a46';
const APPROVED = 'HX0f0e72ce92eef937d6f481b338ecbd19';
const LEAD = { name: 'Tina Lead', email: 'tpl.lead@e2e.ocso.test', password: 'correct-horse-battery-tpllead' };
const EXEC = { name: 'Tom Exec', email: 'tpl.exec@e2e.ocso.test', password: 'correct-horse-battery-tplexec' };
/** A second Head of the team: checks the first one's template submissions (PM/research/11 §4). */
const CHECKER = { name: 'Cara Checker', email: 'tpl.checker@e2e.ocso.test', password: 'correct-horse-battery-tplcheck' };
const STUB_PORT = E2E.apiPort + 3;

let api: APIRequestContext;
let stub: Server;
const sent: Array<Record<string, string>> = [];
const contents = new Map<string, { item: Record<string, unknown>; approval: Record<string, unknown> | null }>([
  [
    APPROVED,
    {
      item: { sid: APPROVED, friendly_name: 'order_ready_pickup', language: 'en', variables: { '1': 'Priya', '2': 'A-10423' }, types: { 'twilio/text': { body: 'Hi {{1}}, your order {{2}} is ready for pickup at the front desk.' } } },
      approval: { name: 'order_ready_pickup', category: 'UTILITY', content_type: 'twilio/text', status: 'approved', rejection_reason: '' },
    },
  ],
]);
const tok: Record<'admin' | 'lead' | 'exec', string> = { admin: '', lead: '', exec: '' };
const ids = { channel: '', webhookPath: '', conversation: '', execId: '', queue: '' };

function reply(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Twilio in the shapes of PM/research/06 and 10 (only what these stories use). */
function twilio(req: IncomingMessage, res: ServerResponse, body: string): void {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`) {
    sent.push(Object.fromEntries(new URLSearchParams(body)));
    return reply(res, 201, { sid: `SM${randomBytes(16).toString('hex')}`, status: 'queued' });
  }
  if (path === '/v1/ContentAndApprovals') return reply(res, 200, { contents: [...contents.values()].map((c) => ({ ...c.item, approval_requests: c.approval ?? { status: 'unsubmitted' } })), meta: { next_page_url: null } });
  if (req.method === 'POST' && path === '/v1/Content') {
    const item = { sid: `HX${randomBytes(16).toString('hex')}`, ...(JSON.parse(body) as Record<string, unknown>) };
    contents.set(item.sid, { item, approval: null });
    return reply(res, 201, item);
  }
  const m = /^\/v1\/Content\/(HX[0-9a-f]{32})(\/ApprovalRequests(?:\/whatsapp)?)?$/.exec(path);
  const content = m ? contents.get(m[1]!) : undefined;
  if (!m || !content) return reply(res, 404, { code: 20404, message: 'not found' });
  if (m[2] === '/ApprovalRequests/whatsapp') {
    content.approval = { ...(JSON.parse(body) as Record<string, unknown>), content_type: Object.keys(content.item['types'] as object)[0], status: 'received', rejection_reason: '' };
    return reply(res, 201, content.approval);
  }
  if (m[2] === '/ApprovalRequests') return reply(res, 200, { sid: m[1], whatsapp: content.approval });
  return reply(res, 200, content.item);
}

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PATCH', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

/** A customer's WhatsApp message, signed like Twilio over the public URL (OCSO_PUBLIC_URL = the web origin). */
async function inbound(text: string): Promise<void> {
  const sid = `SM${randomBytes(16).toString('hex')}`;
  const params: Record<string, string> = { MessageSid: sid, SmsMessageSid: sid, AccountSid: ACCOUNT_SID, From: 'whatsapp:+919812341208', To: 'whatsapp:+14155238886', Body: text, NumMedia: '0', ProfileName: 'Priya Deshmukh', WaId: '919812341208', SmsStatus: 'received' };
  const url = `http://localhost:${E2E.webPort}${ids.webhookPath}`;
  const signature = createHmac('sha1', AUTH_TOKEN).update(Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url)).digest('base64');
  const res = await api.fetch(ids.webhookPath, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, data: new URLSearchParams(params).toString() });
  expect(res.status()).toBe(200);
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(90_000);
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => twilio(req, res, body));
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, '127.0.0.1', resolve));
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const lead = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD.name, email: LEAD.email, role: 'HEAD', password: LEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  // Platform objects go live through a second person's approval (PM/research/11 §4): Tina, a Head, checks the admin's.
  const platformChecker = { id: lead.id, token: tok.lead };
  // Channel adapters reach only public https hosts unless the Tech admin allowlists an internal one (the stub is on loopback).
  await approveOver(api, tok.admin, platformChecker, { method: 'PATCH', path: '/v1/settings/deployment', body: { egressAllowedInternalHosts: ['127.0.0.1'] } });
  const team = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'TPL Cards' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [team] });
  await call('POST', '/v1/users', tok.admin, { name: CHECKER.name, email: CHECKER.email, role: 'HEAD', password: CHECKER.password, teamIds: [team], languages: [], maxConcurrent: 5 });
  ids.execId = (await call<{ id: string }>('POST', '/v1/users', tok.lead, { name: EXEC.name, email: EXEC.email, role: 'SERVICE', password: EXEC.password, teamIds: [team], languages: [], maxConcurrent: 5 })).id;
  tok.exec = await loginApi(EXEC.email, EXEC.password);
  ids.queue = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'TPL Cards', teamIds: [team] })).id;
  const provider = await approvedProvider(api, tok.admin, platformChecker, { kind: 'DEV_SCRIPTED', name: 'TPL Scripted', settings: { latencyMs: 20 } });
  const profile = await approvedProfile(api, tok.admin, platformChecker, { name: 'tpl-support', providerId: provider, model: 'scripted-1', retries: 0 });
  const agent = (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name: 'Maya', slug: 'maya-tpl', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: ids.queue, teamIds: [team] })).id;
  const stubUrl = `http://127.0.0.1:${STUB_PORT}`;
  const channel = await approvedChannel<{ id: string; webhookPath: string }>(api, tok.admin, platformChecker, {
    kind: 'TWILIO_WHATSAPP',
    name: 'TPL WhatsApp',
    settings: { accountSid: ACCOUNT_SID, from: 'whatsapp:+14155238886', apiBaseUrl: stubUrl, contentApiBaseUrl: stubUrl, statusCallback: false },
    secrets: { authToken: AUTH_TOKEN },
  });
  ids.channel = channel.id;
  // channel → pass-through router → Maya's queue (PM/research/11 §5).
  routeChannelToAgent({ channelId: channel.id, agentId: agent, queueId: ids.queue, name: 'TPL WhatsApp' });
  ids.webhookPath = channel.webhookPath;
});

test.afterAll(async () => {
  await api?.dispose();
  await new Promise((resolve) => stub?.close(resolve));
});

test('after 24 hours the exec reaches the customer with an approved template', async ({ page }) => {
  test.setTimeout(90_000);
  await inbound('Is my replacement card ready?');
  await expect.poll(async () => (await call<{ items: Array<{ id: string }> }>('GET', '/v1/conversations?view=all', tok.lead)).items.length, { timeout: 20_000 }).toBeGreaterThan(0);
  ids.conversation = (await call<{ items: Array<{ id: string }> }>('GET', '/v1/conversations?view=all', tok.lead)).items[0]!.id;
  // Maya is a draft (she does not answer), so routing handed the customer straight to a person: it waits in the queue.
  expect((await call<{ controlState: string }>('GET', `/v1/conversations/${ids.conversation}`, tok.lead)).controlState).toBe('WAITING_FOR_HUMAN');
  await call('POST', `/v1/conversations/${ids.conversation}/transfer`, tok.lead, { queueId: ids.queue, userId: ids.execId });
  await call('POST', `/v1/conversations/${ids.conversation}/accept`, tok.exec);
  // The customer's last message was 25 hours ago.
  execFileSync('psql', [databaseUrl, '-qc', `UPDATE conversations SET last_customer_message_at = now() - interval '25 hours' WHERE id = '${ids.conversation}'`]);

  await login(page, EXEC);
  await page.goto(`/conversations/${ids.conversation}`);
  await expect(page.locator('.winline')).toHaveText('24-hour reply window closed — send an approved template');
  await expect(page.getByRole('tab', { name: 'Template' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Reply to customer' })).toHaveCount(0);
  const picker = page.getByRole('group', { name: 'Templates' });
  await expect(picker).toContainText('order_ready_pickup');
  await expect(picker).toContainText('utility');
  await picker.getByRole('button', { name: /order_ready_pickup/ }).click();

  await page.getByLabel('{{1}} · body').fill('Priya');
  await page.getByLabel('{{2}} · body').fill('C-2291');
  await expect(page.getByRole('figure', { name: 'Message preview' })).toContainText('Hi Priya, your order C-2291 is ready for pickup at the front desk.');
  await page.getByRole('button', { name: 'Send template' }).click();

  const timeline = page.getByRole('log', { name: 'Conversation timeline' });
  await expect(timeline.locator('.ev.hum')).toContainText('Hi Priya, your order C-2291 is ready for pickup at the front desk.');
  await expect(timeline.locator('.ev.hum')).toContainText('message template · order_ready_pickup · en · utility');
  // The worker delivers it through Twilio by Content SID.
  await expect.poll(() => sent.find((m) => m['ContentSid'] === APPROVED)?.['ContentVariables'] ?? null, { timeout: 30_000 }).toBe('{"1":"Priya","2":"C-2291"}');
});

test('a template goes to WhatsApp only after a second Head approves it; the maker is told when WhatsApp approves', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, LEAD);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Message templates' }).click();
  await expect(page).toHaveURL(/\/templates\?|\/templates$/);
  await expect(page.getByRole('heading', { name: 'Templates · TPL WhatsApp' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Templates' })).toContainText('order_ready_pickup');
  await page.getByRole('link', { name: 'New template' }).click();

  const form = page.getByRole('form', { name: 'New message template' });
  await form.getByLabel('Name').fill('card_ready');
  await form.getByLabel('Message').fill('Hi {{1}}, your replacement card is ready at the {{2}} branch. Bring an ID.');
  await form.getByLabel('Example for {{1}}').fill('Priya');
  await form.getByLabel('Example for {{2}}').fill('Andheri');
  await expect(page.getByRole('figure', { name: 'Message preview' })).toContainText('Hi Priya, your replacement card is ready at the Andheri branch. Bring an ID.');
  await form.getByRole('button', { name: 'Save and submit for approval' }).click();
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await modal.getByLabel('checker').selectOption({ label: CHECKER.name });
  await modal.getByLabel('reason').fill('Branch pickup notice for replacement cards');
  await modal.getByRole('button', { name: 'Submit for approval' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'card_ready is waiting for a checker' })).toBeVisible();
  const row = page.getByRole('listitem', { name: 'card_ready (en)' });
  await expect(row).toContainText('Draft');
  await expect(row.getByRole('link', { name: /Pending approval · awaiting Cara Checker/ })).toBeVisible();
  // Nothing reached WhatsApp yet.
  expect([...contents.values()].some((c) => c.item['friendly_name'] === 'card_ready')).toBe(false);
  await logout(page);

  await login(page, CHECKER);
  await page.goto('/approvals');
  await page.getByRole('table', { name: 'Approvals' }).getByRole('link', { name: /Submit template card_ready \(en\)/ }).click();
  const d = page.getByRole('dialog', { name: /Submit template card_ready/ });
  await expect(d).toContainText('Hi {{1}}, your replacement card is ready at the {{2}} branch.');
  await d.getByRole('button', { name: 'Approve' }).click();
  // Approved: shown as "activating" until the worker has submitted it to WhatsApp, then "approved".
  await expect(d).toContainText(/approved|activating/);
  // The worker submits it to WhatsApp (once).
  await expect.poll(() => [...contents.values()].filter((c) => c.item['friendly_name'] === 'card_ready').length, { timeout: 30_000 }).toBe(1);
  await logout(page);

  await login(page, LEAD);
  await page.goto(`/templates?channel=${ids.channel}`);
  await expect(row).toContainText('in review');
  await expect(row).toContainText('submitted by Tina Lead');

  // WhatsApp approves; the next status check records it and the submitter is notified in-app.
  const sid = [...contents.keys()].find((k) => contents.get(k)?.item['friendly_name'] === 'card_ready')!;
  contents.get(sid)!.approval!['status'] = 'approved';
  await call('GET', `/v1/channels/${ids.channel}/templates/${sid}`, tok.admin);
  await expect(page.getByRole('status', { name: 'Message template updates' })).toContainText('Template card_ready (en) was approved — execs can now send it.');
  await expect(row).toContainText('approved');
});

test('the old WhatsApp templates URL redirects to Message templates, keeping the channel', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/whatsapp-templates?channel=${ids.channel}`);
  await expect(page).toHaveURL(new RegExp(`/templates\\?channel=${ids.channel}$`));
  await expect(page.getByRole('heading', { name: 'Message templates' })).toBeVisible();
});
