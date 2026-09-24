import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { ACCOUNTS } from './config';
import { USERS, approveAsLead, seedConnectionsStack, submitForApproval } from './connections-setup';
import { login, logout } from './helpers';

/** Channels tab of Connections & models: add / edit channels from the adapters' descriptors. */
test.describe.configure({ mode: 'serial' });
seedConnectionsStack({ mcpDemo: false });

test('Tech admin adds WhatsApp (API problems inline, generated verify token, real Meta handshake) and web chat channels', async ({ page, baseURL }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('WHATSAPP');
  await dialog.getByLabel('Name', { exact: true }).fill('WhatsApp Business');
  await dialog.getByLabel('Phone number id', { exact: true }).fill('106540352242922');
  await dialog.getByLabel('Access token', { exact: true }).fill('EAAG-e2e-not-a-real-token');
  await dialog.getByLabel('App secret', { exact: true }).fill('e2e-app-secret-0123');
  await dialog.getByLabel('Webhook verify token', { exact: true }).fill('short');
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  // Only the API knows the minimum length: its 400 lands under the field.
  await expect(dialog.locator('#ch-sec-verifyToken-error')).toContainText('at least 16 characters');

  await dialog.getByRole('button', { name: 'Generate Webhook verify token' }).click();
  const token = (await dialog.getByLabel('Generated Webhook verify token', { exact: true }).textContent()) ?? '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  const saved = page.getByRole('dialog', { name: 'WhatsApp Business saved' });
  const url = (await saved.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/whatsapp/[A-Za-z0-9_-]+/webhook$`));
  await expect(saved).toContainText('Subscribe the webhook to the messages field');
  await expect(saved).toContainText(token);
  // Meta's subscription handshake through the public ingress succeeds with the generated token.
  const challenge = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=4242`);
  expect(challenge.status).toBe(200);
  expect(await challenge.text()).toBe('4242');
  await saved.getByRole('button', { name: 'Done' }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('accessToken, appSecret, verifyToken set');
  // Card details come from the kind's descriptor: its mark, label and identifying setting.
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' }).getByRole('img', { name: 'WhatsApp' })).toHaveText('WA');
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('WhatsApp — Meta Cloud API');
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('number id106540352242922');
  await cards.getByRole('link', { name: 'Edit WhatsApp Business' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit WhatsApp Business' });
  await expect(dialog.locator('#ch-sec-verifyToken')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-verifyToken"] .cred-state')).toHaveText('set');
  await dialog.getByLabel('Name', { exact: true }).fill('WhatsApp · Cards');
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await page.getByRole('dialog', { name: 'WhatsApp · Cards saved' }).getByRole('button', { name: 'Done' }).click();
  // Blank secrets were kept: the same verify token still passes the handshake.
  expect(await (await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=77`)).text()).toBe('77');

  await page.getByRole('link', { name: 'Add channel' }).click();
  dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('WEBCHAT');
  await dialog.getByLabel('Name', { exact: true }).fill('Web chat');
  await dialog.getByLabel('Allowed origins (optional)', { exact: true }).fill('https://shop.example.com\nhttps://*.meridian.example');
  await dialog.getByLabel('Title (optional)', { exact: true }).fill('Meridian help');
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  const webSaved = page.getByRole('dialog', { name: 'Web chat saved' });
  await expect(webSaved.getByLabel('Embed snippet', { exact: true })).toContainText(`<script src="${baseURL}/ocso-webchat.js" data-key="`);
  await expect(webSaved).toContainText('Only https://shop.example.com, https://*.meridian.example may embed it');
  await webSaved.getByRole('button', { name: 'Done' }).click();
  // The widget page (not a webhook) is where web chat customers arrive.
  await expect(cards.getByRole('listitem', { name: 'Web chat' })).toContainText(/widget\/chat\/[A-Za-z0-9_-]+/);

  // The Webhooks tab lists the WhatsApp callback with what its descriptor says Meta posts; web chat has none.
  await page.goto('/connections?tab=webhooks');
  const hooks = page.getByRole('table', { name: 'Webhooks' });
  await expect(hooks).toContainText('messages, delivery statuses, template reviews');
  await expect(hooks).not.toContainText('/chat/');
  await page.goto('/connections?tab=channels');
  await cards.getByRole('link', { name: 'Edit Web chat' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Web chat' });
  await expect(dialog.getByLabel('Title (optional)', { exact: true })).toHaveValue('Meridian help');
  await expect(dialog.locator('label[for="ch-sec-visitorTokenSecret"] .cred-state')).toHaveText('set'); // generated by the API
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.content()).not.toContain(token);

  // New channels are drafts (customers' messages are refused): activating one is a Head's approval.
  const web = cards.getByRole('listitem', { name: 'Web chat' });
  await expect(web).toContainText('draft');
  await web.getByRole('button', { name: 'Activate Web chat' }).click();
  await submitForApproval(page, 'E2E: open web chat');
  await expect(web).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('channel', 'Activate channel Web chat');
  await page.reload();
  await expect(web).toContainText('live');
  // Live: an edit is a proposal the Head approves; nothing changes until then.
  await cards.getByRole('link', { name: 'Edit Web chat' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Web chat' });
  await dialog.getByLabel('Title (optional)', { exact: true }).fill('Meridian help desk');
  await dialog.getByRole('button', { name: 'Submit change' }).click();
  await submitForApproval(page, 'E2E: new widget title');
  await expect(dialog).toContainText('Sent for approval');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await approveAsLead('channel', 'Change channel Web chat');
  await page.reload();
  await cards.getByRole('link', { name: 'Edit Web chat' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit Web chat' }).getByLabel('Title (optional)', { exact: true })).toHaveValue('Meridian help desk');
  await page.getByRole('dialog', { name: 'Edit Web chat' }).getByRole('button', { name: 'Cancel' }).click();
  // Disabling is immediate.
  await web.getByRole('button', { name: 'Disable' }).click();
  await page.getByRole('dialog', { name: 'Disable Web chat' }).getByRole('button', { name: 'Disable now' }).click();
  await expect(web).toContainText('disabled');
  await logout(page);

  await login(page, USERS.lead);
  await page.goto('/connections?tab=channels');
  await expect(page.getByRole('list', { name: 'Channels' })).toContainText('Web chat');
  await expect(page.getByRole('link', { name: 'Add channel' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Edit / })).toHaveCount(0);
});

test('Tech admin adds a Slack channel from its descriptor: write-only secrets, setup steps with a filled app manifest, activation by approval', async ({ page, baseURL }) => {
  const BOT_TOKEN = 'xoxb-e2e0000001-e2e0000002-NotARealSlackToken';
  const SIGNING_SECRET = 'e2e0slack0signing0secret00000001';
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('SLACK');
  await dialog.getByLabel('Name', { exact: true }).fill('Meridian Slack');
  // Left blank the adapter's default applies (dm_and_mentions); the descriptor's choices are offered.
  await expect(dialog.getByLabel('Respond to (optional)', { exact: true })).toContainText('dm_and_mentions');
  await dialog.getByLabel('Respond to (optional)', { exact: true }).selectOption('dm');
  await dialog.getByLabel('Bot token', { exact: true }).fill('xoxp-a-user-token-not-a-bot');
  await dialog.getByLabel('Signing secret', { exact: true }).fill(SIGNING_SECRET);
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  // The adapter's validation lands under the field.
  await expect(dialog.locator('#ch-sec-botToken-error')).toContainText('Bot User OAuth Token');
  await dialog.getByLabel('Bot token', { exact: true }).fill(BOT_TOKEN);
  await dialog.getByRole('button', { name: 'Add channel' }).click();

  const saved = page.getByRole('dialog', { name: 'Meridian Slack saved' });
  const url = (await saved.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/slack/[A-Za-z0-9_-]+/webhook$`));
  await expect(saved).toContainText('Create New App → From a manifest');
  // The descriptor's app manifest, filled with this channel's webhook for events and interactivity.
  const manifest = saved.getByLabel('Slack app manifest', { exact: true });
  await expect(manifest).toContainText(`"request_url": "${url}"`);
  await expect(manifest).toContainText('"app_mention"');
  await expect(manifest).not.toContainText('{{webhookUrl}}');
  await expect(saved.getByRole('button', { name: 'Download Slack app manifest' })).toBeVisible();
  await saved.getByRole('button', { name: 'Done' }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  const card = cards.getByRole('listitem', { name: 'Meridian Slack' });
  await expect(card.getByRole('img', { name: 'Slack' })).toHaveText('SL');
  await expect(card).toContainText('botToken, signingSecret set');
  await cards.getByRole('link', { name: 'Edit Meridian Slack' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Meridian Slack' });
  await expect(dialog.locator('#ch-sec-botToken')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-botToken"] .cred-state')).toHaveText('set');
  await expect(dialog.getByLabel('Respond to (optional)', { exact: true })).toHaveValue('dm');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const content = await page.content();
  expect(content).not.toContain(BOT_TOKEN);
  expect(content).not.toContain(SIGNING_SECRET);

  // An unsigned request to the webhook is refused before anything is stored.
  expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"url_verification","challenge":"x"}' })).status).toBe(401);

  // A draft until a Head approves its activation.
  await expect(card).toContainText('draft');
  await card.getByRole('button', { name: 'Activate Meridian Slack' }).click();
  await submitForApproval(page, 'E2E: open the Slack app');
  await expect(card).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('channel', 'Activate channel Meridian Slack');
  await page.reload();
  await expect(card).toContainText('live');

  // Slack's Request URL check once live: a signed url_verification gets its challenge back; a bad signature is refused.
  const body = JSON.stringify({ token: 'legacy', type: 'url_verification', challenge: 'e2eChallenge42' });
  const ts = String(Math.floor(Date.now() / 1000));
  const verify = (signature: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature }, body });
  const answered = await verify(`v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`);
  expect(answered.status).toBe(200);
  expect(await answered.text()).toBe('e2eChallenge42');
  expect((await verify(`v0=${'0'.repeat(64)}`)).status).toBe(403);
  await logout(page);
});

test('Tech admin adds a Microsoft Teams channel from its descriptor: settings checked by the adapter, write-only client secret, Teams app manifest with the App ID, activation by approval', async ({ page, baseURL }) => {
  const APP_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT_SECRET = 'e2e~teams.client.secret_NotReal0001';
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('MS_TEAMS');
  await dialog.getByLabel('Name', { exact: true }).fill('Meridian Teams');
  // The descriptor's settings: App ID required, single tenant by default.
  await expect(dialog.getByLabel('App type (optional)', { exact: true })).toContainText('MultiTenant');
  await dialog.getByLabel('Microsoft App ID', { exact: true }).fill('my-bot');
  await dialog.getByLabel('Client secret', { exact: true }).fill(CLIENT_SECRET);
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  // The schema's GUID pattern is checked in the form; the adapter's cross-field rule comes back from the API.
  await expect(dialog.locator('#ch-set-appId-error')).toContainText('Not in the expected format');
  await dialog.getByLabel('Microsoft App ID', { exact: true }).fill(APP_ID);
  await dialog.getByRole('button', { name: 'Add channel' }).click();
  await expect(dialog.locator('#ch-set-tenantId-error')).toContainText('required for a single-tenant bot');
  await dialog.getByLabel('Tenant ID (optional)', { exact: true }).fill(TENANT);
  await dialog.getByRole('button', { name: 'Add channel' }).click();

  const saved = page.getByRole('dialog', { name: 'Meridian Teams saved' });
  const url = (await saved.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/ms-teams/[A-Za-z0-9_-]+/webhook$`));
  await expect(saved).toContainText('Messaging endpoint');
  // The descriptor's Teams app manifest, filled with this channel's App ID as the app and the bot id.
  const manifest = saved.getByLabel('Teams app manifest', { exact: true });
  await expect(manifest).toContainText(`"id": "${APP_ID}"`);
  await expect(manifest).toContainText(`"botId": "${APP_ID}"`);
  await expect(manifest).not.toContainText('{{settings.appId}}');
  await expect(manifest).not.toContainText(CLIENT_SECRET);
  await expect(saved.getByRole('button', { name: 'Download Teams app manifest' })).toBeVisible();
  await saved.getByRole('button', { name: 'Done' }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  const card = cards.getByRole('listitem', { name: 'Meridian Teams' });
  await expect(card.getByRole('img', { name: 'Microsoft Teams' })).toHaveText('MT');
  await expect(card).toContainText('appPassword set');
  await cards.getByRole('link', { name: 'Edit Meridian Teams' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Meridian Teams' });
  await expect(dialog.locator('#ch-sec-appPassword')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-appPassword"] .cred-state')).toHaveText('set');
  await expect(dialog.getByLabel('Microsoft App ID', { exact: true })).toHaveValue(APP_ID);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await page.content()).not.toContain(CLIENT_SECRET);

  // A draft until a Head approves its activation.
  await expect(card).toContainText('draft');
  await card.getByRole('button', { name: 'Activate Meridian Teams' }).click();
  await submitForApproval(page, 'E2E: open the Teams bot');
  await expect(card).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('channel', 'Activate channel Meridian Teams');
  await page.reload();
  await expect(card).toContainText('live');

  // Live: an activity without the Bot Connector's bearer token, or with a malformed one, is refused before anything is stored.
  const activity = JSON.stringify({ type: 'message', id: '1', serviceUrl: 'https://smba.trafficmanager.net/amer/', channelId: 'msteams', text: 'hi' });
  expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: activity })).status).toBe(401);
  expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' }, body: activity })).status).toBe(401);
  await logout(page);
});
