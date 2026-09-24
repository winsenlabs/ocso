import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl, databaseUrl } from './config';
import { login, settled } from './helpers';
import { approvedChannel } from './platform-setup';

/**
 * Linking a chat account to Ask OCSO (Slack / Teams staff channels) on the real stack: the one-time `/link/<token>`
 * page (a signed-out visitor goes to sign-in and comes back; it shows what will be linked; Confirm shows a code that
 * links it once it comes back from that Slack account, sent here as a signed Slack event to the real webhook), the
 * Account page's "Chat accounts" list with Revoke, and a Tech admin revoking a user's link from Team.
 * The token is minted in the database the way Ask OCSO mints one for an unknown sender (sha256 stored only).
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const HANA = { name: 'Hana Linker', email: `hana.linker.${RUN}@e2e.ocso.test`, password: 'correct-horse-battery-hana' };
const CHANNEL = `Ask OCSO Slack ${RUN}`;
const TEAM_ID = 'T0E2E' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
const SIGNING_SECRET = 'c1d2e3f4a5b60718293a4b5c6d7e8f90';
let api: APIRequestContext;
const ids: { admin: string; hana: string; channel: string; webhookPath: string } = { admin: '', hana: '', channel: '', webhookPath: '' };
let events = 0;
const tok: { admin: string; hana: string } = { admin: '', hana: '' };

async function call<T = Record<string, unknown>>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (res.status() >= 300) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}

function sql(statement: string): string {
  return execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tAqc', statement], { stdio: 'pipe', env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' } })
    .toString()
    .trim();
}

/** A one-time link for a Slack user of this run's workspace, stored as Ask OCSO stores it (hash only). */
function mintLink(slackUser: string, profileName: string): string {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  sql(
    `INSERT INTO channel_link_tokens (token_hash, channel_id, identity_kind, identity_value, profile_name, reply_context, expires_at)
     VALUES ('${hash}', '${ids.channel}', 'slack_user', '${TEAM_ID}:${slackUser}', '${profileName}', '{"teamId":"${TEAM_ID}","channel":"D0E2EDM01"}', now() + interval '10 minutes')`,
  );
  return token;
}

/** `slackUser` sends `text` to the app in a DM: a signed Slack event on the channel's real webhook (replies go nowhere). */
async function slackDm(slackUser: string, text: string): Promise<void> {
  events += 1;
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM_ID,
    api_app_id: 'A0E2E',
    event_id: `Ev0E2E${RUN}${events}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: TEAM_ID, user_id: 'U0E2EBOT01', is_bot: true }],
    event: { type: 'message', channel_type: 'im', channel: 'D0E2EDM01', user: slackUser, team: TEAM_ID, text, ts: `${Math.floor(Date.now() / 1000)}.00${events}` },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  const res = await api.fetch(ids.webhookPath, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature }, data: body });
  expect(res.status()).toBe(200);
}

/** The link of a Slack user of this run, once made (the code is handled in the background). */
async function linkedUser(slackUser: string): Promise<string> {
  let user = '';
  await expect
    .poll(() => (user = sql(`SELECT user_id FROM channel_account_links WHERE identity_value = '${TEAM_ID}:${slackUser}' AND revoked_at IS NULL`)), { timeout: 15_000 })
    .not.toBe('');
  return user;
}

const chatAccounts = (page: Page) => page.getByRole('region', { name: 'Chat accounts' });

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(120_000);
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password });
  }
  const admin = await call<{ token: string; user: { id: string } }>('POST', '/v1/auth/login', null, { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password });
  tok.admin = admin.token;
  ids.admin = admin.user.id;
  ids.hana = (await call<{ id: string }>('POST', '/v1/users', tok.admin, { name: HANA.name, email: HANA.email, role: 'HEAD', password: HANA.password, teamIds: [], languages: [], maxConcurrent: 5 })).id;
  tok.hana = (await call<{ token: string }>('POST', '/v1/auth/login', null, { email: HANA.email, password: HANA.password })).token;
  // A Slack channel whose destination is Ask OCSO (Hana, a Head, approves its activation). Nothing here reaches Slack.
  const created = await approvedChannel<{ id: string; webhookPath: string }>(api, tok.admin, { id: ids.hana, token: tok.hana }, {
      kind: 'SLACK',
      name: CHANNEL,
      settings: { destination: 'ask_ocso', respondTo: 'dm', apiBaseUrl: 'http://localhost:9/api' },
      secrets: { botToken: 'xoxb-fake-test-token-03', signingSecret: SIGNING_SECRET },
    });
  ids.channel = created.id;
  ids.webhookPath = created.webhookPath;
});

test.afterAll(async () => {
  await api?.dispose();
});

test('the link page sends a signed-out visitor to sign in and back, shows what it links, and links it once the code comes back', async ({ page }) => {
  const token = mintLink('U0E2EHANA1', 'Hana in Slack');
  await page.goto(`/link/${token}`);
  await page.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('next') === `/link/${token}`);
  await page.getByLabel('Work email').fill(HANA.email);
  await page.getByLabel('Password', { exact: true }).fill(HANA.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === `/link/${token}`);

  await expect(page.getByRole('heading', { name: 'Link your Slack account' })).toBeVisible();
  const facts = page.getByLabel('What will be linked');
  await expect(facts).toContainText('Hana in Slack · slack · U0E2EHANA1');
  await expect(facts).toContainText(CHANNEL);
  await expect(facts).toContainText(`${HANA.name} (${HANA.email})`);
  // The full account id names the Slack workspace, so a link for someone else's workspace stands out.
  await expect(facts).toContainText(`${TEAM_ID}:U0E2EHANA1`);
  await page.getByRole('button', { name: 'Confirm link' }).click();
  const code = page.getByTestId('link-code');
  await expect(code).toHaveText(/^\d{6}$/);
  await expect(page.getByText('Never give this code to anyone.')).toBeVisible();
  // Nothing is linked until the code comes back from that Slack account.
  expect(sql(`SELECT count(*) FROM channel_account_links WHERE identity_value = '${TEAM_ID}:U0E2EHANA1'`)).toBe('0');
  await slackDm('U0E2EHANA1', (await code.textContent())!.trim());
  expect(await linkedUser('U0E2EHANA1')).toBe(ids.hana);

  await page.reload();
  await expect(page.getByText('This link was already used.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm link' })).toHaveCount(0);
});

test('Account lists the linked chat account and revokes it at once', async ({ page }) => {
  await login(page, HANA);
  await page.goto('/account/security');
  await settled(page);
  const card = chatAccounts(page);
  await expect(card).toContainText('Slack · Hana in Slack (slack · U0E2EHANA1)');
  await expect(card).toContainText(`channel ${CHANNEL}`);
  await expect(card).toContainText('last used never');
  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Revoke Slack Hana in Slack' }).click();
  await expect(card).toContainText('None yet.');
  expect(sql(`SELECT count(*) FROM channel_account_links WHERE identity_value = '${TEAM_ID}:U0E2EHANA1' AND revoked_at IS NULL`)).toBe('0');
  expect(sql(`SELECT count(*) FROM audit_events WHERE action = 'channel.account_unlink' AND actor_id = '${ids.hana}'`)).toBe('1');
});

test("a Tech admin sees a user's chat account on Team and revokes it", async ({ page }) => {
  const token = mintLink('U0E2EHANA2', 'Hana again');
  const claimed = await call<{ code: string }>('POST', '/v1/internal-agent/link-tokens/confirm', tok.hana, { token });
  await slackDm('U0E2EHANA2', claimed.code);
  await linkedUser('U0E2EHANA2');
  await login(page, ACCOUNTS.admin);
  await page.goto(`/team?user=${ids.hana}`);
  await settled(page);
  const card = chatAccounts(page);
  await expect(card).toContainText('Slack · Hana again (slack · U0E2EHANA2)');
  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Revoke Slack Hana again' }).click();
  await expect(card).toContainText(`${HANA.name} has not linked a chat account.`);
  expect(sql(`SELECT count(*) FROM channel_account_links WHERE user_id = '${ids.hana}' AND revoked_at IS NULL`)).toBe('0');
});
