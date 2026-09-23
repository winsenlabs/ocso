import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, webUrl } from './config';

/**
 * Customer web chat end to end: a host site (examples/webchat-host) embeds
 * public/ocso-webchat.js; the customer chats with the AI (DEV_SCRIPTED model
 * run by the e2e worker), reloads, uploads an image, asks for a human and
 * sees a colleague join and reply; then the host identifies the customer.
 * Seeded through the real API.
 */
test.describe.configure({ mode: 'serial' });

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOST_PORT = E2E.webPort + 7;
const HOST = `http://localhost:${HOST_PORT}`;
const EXEC = { name: 'Esha Web', email: 'wc.exec@e2e.ocso.test', password: 'correct-horse-battery-wcexec' };
const LEAD = { name: 'Wren Lead', email: 'wc.lead@e2e.ocso.test', password: 'correct-horse-battery-wclead' };
const CHANNEL = 'WC Example Store chat';
const HOST_JWT_SECRET = randomBytes(32).toString('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let api: APIRequestContext;
/** One browser profile for the whole story: the visitor token lives in the widget's storage. */
let customer: BrowserContext;
let host: ChildProcess | null = null;
const tok = { admin: '', lead: '', exec: '' };
const ids = { key: '', conversation: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;

async function startHost(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(repo, 'examples/webchat-host/server.mjs')], {
    env: { ...process.env, PORT: String(HOST_PORT), OCSO_URL: webUrl, OCSO_WEBCHAT_KEY: ids.key, OCSO_HOST_JWT_SECRET: HOST_JWT_SECRET },
    stdio: 'ignore',
  });
  await expect.poll(async () => (await api.fetch(HOST).catch(() => null))?.status() ?? 0, { timeout: 15_000 }).toBe(200);
  return child;
}

/** Open the launcher on the host page; returns the chat iframe. */
async function openChat(page: Page): Promise<FrameLocator> {
  const launcher = page.getByRole('button', { name: /^Open chat/ });
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  await launcher.click();
  const chat = page.frameLocator('iframe[title^="Chat"]');
  await expect(chat.getByRole('textbox', { name: 'Message' })).toBeFocused();
  return chat;
}

const log = (chat: FrameLocator) => chat.getByRole('log', { name: 'Conversation' });

async function waitingConversation(): Promise<string> {
  let id = '';
  await expect
    .poll(async () => {
      const list = await call<{ items: Array<{ id: string; channel: { name: string | null } }> }>('GET', '/v1/conversations?view=waiting', tok.exec);
      id = list.items.find((c) => c.channel.name === CHANNEL)?.id ?? '';
      return id;
    }, { timeout: 30_000, intervals: [500] })
    .not.toBe('');
  return id;
}

test.beforeAll(async ({ playwright, browser }) => {
  test.setTimeout(90_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  customer = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const lead = await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: LEAD.name, email: LEAD.email, role: 'HEAD', password: LEAD.password, teamIds: [], languages: [], maxConcurrent: 5 });
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  const team = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'WC Orders' })).id;
  // The lead manages the agent through an owning team of their own, outside the queue's team (ADR-026).
  const owners = (await call<{ id: string }>('POST', '/v1/teams', tok.lead, { name: 'WC Agent owners' })).id;
  await call('PATCH', `/v1/users/${lead.id}`, tok.admin, { teamIds: [owners] });
  // The exec's team is not one of the lead's, so the Tech admin creates them (a lead creates execs only into their own teams).
  await call('POST', '/v1/users', tok.admin, { name: EXEC.name, email: EXEC.email, role: 'SERVICE', password: EXEC.password, teamIds: [team], languages: [], maxConcurrent: 5 });
  tok.exec = await loginApi(EXEC.email, EXEC.password);
  const queue = (await call<{ id: string }>('POST', '/v1/queues', tok.lead, { name: 'WC Orders · Tier 1', teamIds: [team] })).id;
  // Deterministic development model (ADR-015); slow enough chunks that streaming is observable.
  const provider = (await call<{ id: string }>('POST', '/v1/model-providers', tok.admin, { kind: 'DEV_SCRIPTED', name: 'WC Scripted', settings: { latencyMs: 100, chunkDelayMs: 80 } })).id;
  const profile = (await call<{ id: string }>('POST', '/v1/model-profiles', tok.admin, { name: 'wc-support', providerId: provider, model: 'scripted-1', retries: 0 })).id;
  const agent = (await call<{ id: string }>('POST', '/v1/agents', tok.lead, { name: 'Ava', slug: 'ava-wc', purpose: 'order support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queue, teamIds: [owners] })).id;
  await call('POST', `/v1/agents/${agent}/status`, tok.lead, { status: 'LIVE' });
  const channel = await call<{ publicKey: string }>('POST', '/v1/channels', tok.admin, {
    kind: 'WEBCHAT',
    name: CHANNEL,
    status: 'ACTIVE',
    defaultAgentId: agent,
    settings: { allowedOrigins: [HOST], branding: { title: 'Example Store help', accentColor: '#0f766e', greeting: 'Hi! Ask us anything about your order.' } },
    secrets: { visitorTokenSecret: randomBytes(32).toString('hex'), hostJwtSecret: HOST_JWT_SECRET },
  });
  ids.key = channel.publicKey;
  host = await startHost();
});

test.afterAll(async () => {
  host?.kill('SIGTERM');
  await customer?.close();
  await api?.dispose();
});

/** A fresh tab in the customer's browser profile. */
const tab = () => customer.newPage();

test('the widget page is public and only frameable by allowed host sites', async ({ request }) => {
  const res = await request.get(`/chat/${ids.key}`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-security-policy']).toContain(`frame-ancestors 'self' ${HOST}`);
  expect(res.headers()['content-security-policy']).toContain("connect-src 'self'");
  const loader = await request.get('/ocso-webchat.js', { maxRedirects: 0 });
  expect(loader.status()).toBe(200);
  expect(loader.headers()['content-type']).toContain('javascript');
  const unknown = await request.get('/chat/pk_does_not_exist_000', { maxRedirects: 0 });
  expect(unknown.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('an unknown channel shows an honest unavailable state', async ({ page }) => {
  await page.goto('/chat/pk_does_not_exist_000');
  await expect(page.getByRole('alert').filter({ hasText: 'Chat is unavailable' })).toContainText('This chat isn’t available right now.');
});

test('a customer on the host site chats with the AI and sees the reply stream in', async () => {
  test.setTimeout(60_000);
  const page = await tab();
  await page.goto(HOST);
  const chat = await openChat(page);
  await expect(chat.getByRole('heading', { name: 'Example Store help' })).toBeVisible();
  await expect(chat.getByText('Hi! Ask us anything about your order.')).toBeVisible();

  await chat.getByRole('textbox', { name: 'Message' }).fill('Where is my order 4411?');
  await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
  const mine = log(chat).locator('.wc-row.me').last();
  await expect(mine).toContainText('Where is my order 4411?');
  await expect(mine.locator('.wc-meta')).toContainText('Sent', { timeout: 10_000 });

  // Deltas render as a streaming draft before the stored message replaces it.
  await expect(log(chat).locator('.wc-bubble.streaming')).toBeVisible({ timeout: 30_000 });
  const reply = log(chat).locator('.wc-row.ai').last();
  await expect(reply).toContainText('You said: "Where is my order 4411?"', { timeout: 30_000 });
  await expect(log(chat).locator('.wc-bubble.streaming')).toHaveCount(0);
  await expect(log(chat).locator('.wc-row.ai .wc-author').first()).toHaveText('Ava · AI assistant');
  await expect(log(chat).locator('.wc-row.ai')).toHaveCount(1);
});

test('reloading the host page resumes the same conversation from history', async () => {
  const page = await tab();
  await page.goto(HOST);
  const chat = await openChat(page);
  await expect(log(chat).locator('.wc-row.me')).toContainText('Where is my order 4411?');
  await expect(log(chat).locator('.wc-row.ai')).toContainText('You said: "Where is my order 4411?"');
  await expect(log(chat).locator('.wc-row')).toHaveCount(2);
});

test('the customer uploads an image that the AI receives', async () => {
  test.setTimeout(60_000);
  const page = await tab();
  await page.goto(HOST);
  const chat = await openChat(page);
  await chat.getByTestId('wc-file-input').setInputFiles({ name: 'parcel.png', mimeType: 'image/png', buffer: PNG });
  const chip = chat.locator('.wc-chip');
  await expect(chip).toContainText('parcel.png');
  await expect(chip.locator('.bar')).toHaveCount(0, { timeout: 10_000 });
  await chat.getByRole('textbox', { name: 'Message' }).fill('Here is the damaged parcel');
  await chat.getByRole('button', { name: 'Send message' }).click();
  const mine = log(chat).locator('.wc-row.me').last();
  await expect(mine.locator('img.wc-img')).toBeVisible();
  await expect(log(chat).locator('.wc-row.ai').last()).toContainText('I received 1 attachment', { timeout: 30_000 });
  // The stored copy points at a signed OCSO blob URL (after a reload there is no local preview).
  await page.reload();
  const again = await openChat(page);
  await expect(log(again).locator('.wc-row.me img.wc-img')).toHaveAttribute('src', /\/blobs\/webchat\//);
});

test('asking for a human shows the handoff notice; a colleague joins and replies', async () => {
  test.setTimeout(90_000);
  const page = await tab();
  await page.goto(HOST);
  const chat = await openChat(page);
  await chat.getByRole('textbox', { name: 'Message' }).fill('I want to talk to a human please');
  await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(log(chat).locator('.wc-notice.waiting')).toHaveText('Connecting you to a colleague…', { timeout: 30_000 });
  await expect(chat.getByTestId('wc-status')).toHaveText('Connecting you to a colleague…');

  ids.conversation = await waitingConversation();
  await call('POST', `/v1/conversations/${ids.conversation}/claim`, tok.exec);
  await expect(log(chat).locator('.wc-notice.joined')).toHaveText('Esha joined the conversation', { timeout: 15_000 });
  await expect(chat.getByTestId('wc-status')).toHaveText('Esha from our team is here');

  await call('POST', `/v1/conversations/${ids.conversation}/messages`, tok.exec, { clientMessageId: `h-${randomBytes(6).toString('hex')}`, parts: [{ type: 'TEXT', text: 'Hi, Esha here. I have your photo and will arrange a replacement.' }] });
  const human = log(chat).locator('.wc-row.hum').last();
  await expect(human).toContainText('I have your photo and will arrange a replacement.', { timeout: 15_000 });
  await expect(log(chat).locator('.wc-row.hum .wc-author').first()).toHaveText('Esha · Support team');
  await expect(chat.getByRole('status').filter({ hasText: 'New message from Esha' })).toBeAttached();

  // Notices are stored events: they survive a reload in the same order.
  await page.reload();
  const again = await openChat(page);
  await expect(log(again).locator('.wc-notice')).toHaveText(['Connecting you to a colleague…', 'Esha joined the conversation']);
  await expect(again.getByRole('textbox', { name: 'Message' })).toHaveAttribute('placeholder', 'Write to Esha…');
});

test('the host identifies the customer with a signed JWT; the conversation continues, sign-out starts over', async () => {
  test.setTimeout(60_000);
  const page = await tab();
  await page.goto(HOST);
  const chat = await openChat(page);
  await expect(log(chat).locator('.wc-row.hum')).toHaveCount(1);
  await page.getByRole('button', { name: 'Sign in as demo customer' }).click();
  await expect(page.locator('#log')).toHaveText('Chat now knows you as cus-demo-001.');
  // The guest's conversation carries over to the identified customer.
  await expect(log(chat).locator('.wc-row.hum')).toHaveCount(1);
  await chat.getByRole('textbox', { name: 'Message' }).fill('I am signed in now');
  await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(log(chat).locator('.wc-row.me').last().locator('.wc-meta')).toContainText('Sent', { timeout: 10_000 });
  await expect
    .poll(async () => (await call<{ customer: { identities: Array<{ kind: string }> } }>('GET', `/v1/conversations/${ids.conversation}`, tok.exec)).customer.identities.map((i) => i.kind), { timeout: 10_000 })
    .toContain('webchat_customer_ref');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(log(chat).locator('.wc-row')).toHaveCount(0);
  await expect(chat.getByText('Hi! Ask us anything about your order.')).toBeVisible();
});

test('on a phone the panel fills the screen and closes with its close button', async () => {
  const page = await tab();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(HOST);
  const chat = await openChat(page);
  const box = await page.locator('iframe[title^="Chat"]').boundingBox();
  expect(box?.width).toBeCloseTo(390, 0);
  expect(box?.height).toBeCloseTo(844, 0);
  await chat.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('button', { name: /^Open chat/ })).toHaveAttribute('aria-expanded', 'false');
  // Closed: invisible and inert (kept rendered so the widget keeps running for unread badges).
  await expect(page.locator('[data-ocso-webchat] .panel')).toHaveAttribute('inert', '');
  await expect(page.locator('[data-ocso-webchat] .panel')).toHaveCSS('opacity', '0');
});
