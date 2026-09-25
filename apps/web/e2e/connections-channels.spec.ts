import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { ACCOUNTS } from './config';
import { USERS, approveAsLead, seedConnectionsStack, submitForApproval } from './connections-setup';
import { login, logout } from './helpers';

/** Integrations → Channels: add / set up / edit channels from the adapters' descriptors (guides, setup files). */
test.describe.configure({ mode: 'serial' });
seedConnectionsStack({ mcpDemo: false });

test('Tech admin adds WhatsApp (API problems inline, generated verify token, real Meta handshake) and web chat channels', async ({ page, baseURL }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('WHATSAPP');
  await dialog.getByLabel('Name', { exact: true }).fill('WhatsApp Business');
  // A webhook kind starts as a bare draft: Meta needs the webhook URL before anything else.
  await expect(dialog.getByRole('region', { name: 'How setting up WhatsApp — Meta Cloud API works' })).toContainText('Create a draft now');
  await dialog.getByRole('button', { name: 'Create draft and continue' }).click();
  dialog = page.getByRole('dialog', { name: 'Set up WhatsApp Business' });
  const url = (await dialog.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/whatsapp/[A-Za-z0-9_-]+/webhook$`));
  await expect(dialog).toContainText('Still needed before it can be activated: Access token, App secret, Webhook verify token');
  const guide = dialog.getByRole('list', { name: 'WhatsApp — Meta Cloud API setup guide' });
  await expect(guide.getByLabel('Callback URL', { exact: true })).toHaveText(url);
  await expect(guide).toContainText('message_template_status_update');
  await dialog.getByLabel('Phone number id', { exact: true }).fill('106540352242922');
  await dialog.locator('#ch-sec-accessToken').fill('EAAG-e2e-not-a-real-token');
  await dialog.locator('#ch-sec-appSecret').fill('e2e-app-secret-0123');
  await dialog.locator('#ch-sec-verifyToken').fill('short');
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  // Only the API knows the minimum length: its 400 lands under the field.
  await expect(dialog.locator('#ch-sec-verifyToken-error')).toContainText('at least 16 characters');

  await dialog.getByRole('button', { name: 'Generate Webhook verify token' }).click();
  const token = (await dialog.getByLabel('Generated Webhook verify token', { exact: true }).textContent()) ?? '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog).toContainText('Saved WhatsApp Business');
  await expect(dialog).toContainText('Draft · credentials saved');
  // The generated token stays on screen in this dialog, to paste into Meta.
  await expect(dialog).toContainText(`Generated in this dialog, shown only now: Webhook verify token ${token}`);
  // Meta's subscription handshake through the public ingress succeeds with the generated token.
  const challenge = await fetch(`${url}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=4242`);
  expect(challenge.status).toBe(200);
  expect(await challenge.text()).toBe('4242');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('accessToken, appSecret, verifyToken set');
  // Card details come from the kind's descriptor: its mark, label and identifying setting.
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' }).getByRole('img', { name: 'WhatsApp' })).toHaveText('WA');
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('WhatsApp — Meta Cloud API');
  await expect(cards.getByRole('listitem', { name: 'WhatsApp Business' })).toContainText('number id106540352242922');
  await cards.getByRole('link', { name: 'Edit WhatsApp Business' }).click();
  dialog = page.getByRole('dialog', { name: 'Set up WhatsApp Business' });
  await expect(dialog.locator('#ch-sec-verifyToken')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-verifyToken"] .cred-state')).toHaveText('set');
  await dialog.getByLabel('Name', { exact: true }).fill('WhatsApp · Cards');
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog).toContainText('Saved WhatsApp · Cards');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
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

test('Tech admin sets up a Slack channel: draft first, manifest (YAML and JSON) downloaded with its webhook URL, the guide walked through, secrets in the guide, URL check answered, activation by approval', async ({ page, baseURL }) => {
  const BOT_TOKEN = 'xoxb-e2e0000001-e2e0000002-NotARealSlackToken';
  const SIGNING_SECRET = 'e2e0slack0signing0secret00000001';
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('SLACK');
  await dialog.getByLabel('Name', { exact: true }).fill('Meridian Slack');
  const plan = dialog.getByRole('region', { name: 'How setting up Slack works' });
  await expect(plan).toContainText('Slack app manifest (YAML) and Slack app manifest (JSON) ready to download');
  await expect(plan).toContainText('Paste the bot token, signing secret');
  await dialog.getByRole('button', { name: 'Create draft and continue' }).click();

  // Step 2: the draft exists, so its webhook URL is real and the manifest can be downloaded before any Slack value exists.
  dialog = page.getByRole('dialog', { name: 'Set up Meridian Slack' });
  const url = (await dialog.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/slack/[A-Za-z0-9_-]+/webhook$`));
  await expect(dialog).toContainText('Still needed before it can be activated: Bot token, Signing secret');
  const guide = dialog.getByRole('list', { name: 'Slack setup guide' });
  await expect(guide.getByRole('listitem').filter({ has: page.locator('.cg-title') })).toHaveCount(10);
  const yamlFile = guide.getByRole('group', { name: 'Slack app manifest (YAML)' });
  const [yamlDownload] = await Promise.all([page.waitForEvent('download'), yamlFile.getByRole('button', { name: 'Download Slack app manifest (YAML)' }).click()]);
  expect(yamlDownload.suggestedFilename()).toBe('slack-app-manifest.yaml');
  const yaml = await readFile((await yamlDownload.path())!, 'utf8');
  expect(yaml).toContain(`request_url: ${url}`);
  for (const scope of ['chat:write', 'im:history', 'app_mentions:read', 'users:read', 'users:read.email']) expect(yaml).toContain(`- ${scope}\n`);
  expect(yaml).toContain('messages_tab_read_only_enabled: false');
  expect(yaml).toContain('socket_mode_enabled: false');
  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), guide.getByRole('button', { name: 'Download Slack app manifest (JSON)' }).click()]);
  const manifest = JSON.parse(await readFile((await jsonDownload.path())!, 'utf8')) as { settings: { event_subscriptions: { request_url: string; bot_events: string[] }; interactivity: { request_url: string } } };
  expect(manifest.settings.event_subscriptions).toEqual({ request_url: url, bot_events: ['app_mention', 'message.im'] });
  expect(manifest.settings.interactivity.request_url).toBe(url);
  await expect(guide.getByLabel('Request URL', { exact: true }).first()).toHaveText(url);
  // The scopes table says why OCSO needs each one.
  await expect(guide.getByRole('table')).toContainText('im:history');
  await expect(guide.getByRole('table')).toContainText('Receive direct messages to the app');
  for (const n of [1, 2, 3, 4]) await guide.getByLabel(`Mark step ${n} done`).check();

  // Step 5 holds OCSO's own form: the adapter's validation lands under the field.
  await dialog.getByLabel('Respond to (optional)', { exact: true }).selectOption('dm');
  await dialog.locator('#ch-sec-botToken').fill('xoxp-a-user-token-not-a-bot');
  await dialog.locator('#ch-sec-signingSecret').fill(SIGNING_SECRET);
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog.locator('#ch-sec-botToken-error')).toContainText('Bot User OAuth Token');
  await dialog.locator('#ch-sec-botToken').fill(BOT_TOKEN);
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog).toContainText('Saved Meridian Slack');
  await expect(dialog).toContainText('Draft · credentials saved');
  await guide.getByLabel('Mark step 5 done').check();

  // Step 6: with the signing secret saved, Slack's Request URL check is answered even though the channel is a draft.
  const body = JSON.stringify({ token: 'legacy', type: 'url_verification', challenge: 'e2eChallenge42' });
  const verify = (signature: string, ts = String(Math.floor(Date.now() / 1000))) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature }, body });
  const sign = (ts: string) => `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const draftAnswer = await verify(sign(ts), ts);
  expect(draftAnswer.status).toBe(200);
  expect(await draftAnswer.text()).toBe('e2eChallenge42');
  await expect(guide).toContainText('Allow users to send Slash commands and messages from the messages tab');
  await expect(guide).toContainText('/invite @ocso-assistant');
  for (const n of [6, 7, 8, 9]) await guide.getByLabel(`Mark step ${n} done`).check();
  // The troubleshooting list answers the known problems.
  await dialog.locator('#troubleshooting > summary').click();
  await expect(dialog.locator('#ts-missing-scope')).toContainText('reinstall the app');
  await expect(dialog.locator('#ts-not-in-channel')).toContainText('/invite');
  const content = await page.content();
  expect(content).not.toContain(BOT_TOKEN);
  expect(content).not.toContain(SIGNING_SECRET);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  const card = cards.getByRole('listitem', { name: 'Meridian Slack' });
  await expect(card.getByRole('img', { name: 'Slack' })).toHaveText('SL');
  await expect(card).toContainText('botToken, signingSecret set');
  await cards.getByRole('link', { name: 'Edit Meridian Slack' }).click();
  dialog = page.getByRole('dialog', { name: 'Set up Meridian Slack' });
  await expect(dialog.locator('#ch-sec-botToken')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-botToken"] .cred-state')).toHaveText('set');
  await expect(dialog.getByLabel('Respond to (optional)', { exact: true })).toHaveValue('dm');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

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

  // Live: the guide sits under the form, and a signed url_verification still gets its challenge back; a bad signature is refused.
  await cards.getByRole('link', { name: 'Edit Meridian Slack' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit Meridian Slack' });
  await expect(dialog.getByText('Setup guide · 10 steps')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const liveTs = String(Math.floor(Date.now() / 1000));
  const answered = await verify(sign(liveTs), liveTs);
  expect(answered.status).toBe(200);
  expect(await answered.text()).toBe('e2eChallenge42');
  expect((await verify(`v0=${'0'.repeat(64)}`)).status).toBe(403);
  await logout(page);
});

test('Tech admin sets up a Microsoft Teams channel: draft first, messaging endpoint to copy, settings in the guide, app package zip downloaded once the App ID is saved, activation by approval', async ({ page, baseURL }) => {
  const APP_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const CLIENT_SECRET = 'e2e~teams.client.secret_NotReal0001';
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('MS_TEAMS');
  await dialog.getByLabel('Name', { exact: true }).fill('Meridian Teams');
  await expect(dialog.getByRole('region', { name: 'How setting up Microsoft Teams works' })).toContainText('Teams app package ready to download');
  await dialog.getByRole('button', { name: 'Create draft and continue' }).click();

  dialog = page.getByRole('dialog', { name: 'Set up Meridian Teams' });
  const url = (await dialog.getByLabel('Webhook URL', { exact: true }).textContent()) ?? '';
  expect(url).toMatch(new RegExp(`^${baseURL}/channels/ms-teams/[A-Za-z0-9_-]+/webhook$`));
  const guide = dialog.getByRole('list', { name: 'Microsoft Teams setup guide' });
  await expect(guide).toContainText('Create new Microsoft App ID');
  await expect(guide.getByLabel('Messaging endpoint', { exact: true })).toHaveText(url);
  // The package holds the App ID: until it is saved, the download waits and says why.
  const pkg = guide.getByRole('group', { name: 'Teams app package' });
  await expect(pkg.getByRole('button', { name: 'Download Teams app package' })).toBeDisabled();
  await expect(pkg).toContainText('Fill in appId and save before using this file.');
  for (const n of [1, 2, 3, 4, 5]) await guide.getByLabel(`Mark step ${n} done`).check();

  // The form sits in step 6. The schema's GUID pattern is checked in the form.
  await expect(dialog.getByLabel('App type (optional)', { exact: true })).toContainText('MultiTenant');
  await dialog.getByLabel('Microsoft App ID', { exact: true }).fill('my-bot');
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog.locator('#ch-set-appId-error')).toContainText('Not in the expected format');
  await dialog.getByLabel('Microsoft App ID', { exact: true }).fill(APP_ID);
  await dialog.getByLabel('Tenant ID (optional)', { exact: true }).fill(TENANT);
  await dialog.locator('#ch-sec-appPassword').fill(CLIENT_SECRET);
  await dialog.getByRole('button', { name: 'Save channel' }).click();
  await expect(dialog).toContainText('Saved Meridian Teams');
  await expect(dialog).toContainText('Draft · credentials saved');

  // Step 7: the app package, built by the server from the saved App ID (never the client secret).
  const href = (await pkg.getByRole('link', { name: 'Download Teams app package' }).getAttribute('href')) ?? '';
  const probe = await page.request.get(href);
  expect(probe.status(), await probe.text()).toBe(200);
  expect(probe.headers()['content-type']).toBe('application/zip');
  expect(probe.headers()['content-disposition']).toBe('attachment; filename="ocso-teams-app.zip"');
  const [download] = await Promise.all([page.waitForEvent('download'), pkg.getByRole('link', { name: 'Download Teams app package' }).click()]);
  expect(download.suggestedFilename()).toBe('ocso-teams-app.zip');
  const zip = await readFile((await download.path())!);
  expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
  const text = zip.toString('latin1');
  for (const name of ['manifest.json', 'color.png', 'outline.png']) expect(text).toContain(name);
  expect(text).toContain(`"botId": "${APP_ID}"`);
  expect(text).toContain('"manifestVersion": "1.30"');
  expect(text).not.toContain(CLIENT_SECRET);
  await expect(guide).toContainText('Upload a custom app');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const cards = page.getByRole('list', { name: 'Channels' });
  const card = cards.getByRole('listitem', { name: 'Meridian Teams' });
  await expect(card.getByRole('img', { name: 'Microsoft Teams' })).toHaveText('MT');
  await expect(card).toContainText('appPassword set');
  await cards.getByRole('link', { name: 'Edit Meridian Teams' }).click();
  dialog = page.getByRole('dialog', { name: 'Set up Meridian Teams' });
  await expect(dialog.locator('#ch-sec-appPassword')).toHaveValue('');
  await expect(dialog.locator('label[for="ch-sec-appPassword"] .cred-state')).toHaveText('set');
  await expect(dialog.getByLabel('Microsoft App ID', { exact: true })).toHaveValue(APP_ID);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
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
