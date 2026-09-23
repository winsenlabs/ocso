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
