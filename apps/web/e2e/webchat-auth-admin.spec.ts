import { expect, test } from '@playwright/test';
import { ACCOUNTS, apiUrl } from './config';
import { approveAsLead, seedConnectionsStack, submitForApproval } from './connections-setup';
import { login } from './helpers';

/**
 * SPEC §C.7: a Tech admin sets a web chat channel to "client" auth (session passes), copies the secret key the
 * one time OCSO shows it, uses it server-to-server, and rotates it through maker–checker.
 */
test.describe.configure({ mode: 'serial' });
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
seedConnectionsStack({ mcpDemo: false });

const mintPass = (publishableKey: string, secretKey: string) =>
  fetch(`${apiUrl}/public/webchat/${publishableKey}/session-pass`, { method: 'POST', headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ context: { plan: 'gold' } }) });

test('admin configures client mode, copies the secret key once, and rotates it', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=channels');
  await page.getByRole('link', { name: 'Add channel' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add channel' });
  await dialog.getByLabel('Channel type').selectOption('WEBCHAT');
  await dialog.getByLabel('Name', { exact: true }).fill('App chat');
  await dialog.getByLabel('Allowed origins (optional)', { exact: true }).fill('https://app.example.com');
  await dialog.getByLabel('Auth mode (optional)', { exact: true }).selectOption('client');
  await dialog.getByLabel('Allowed context keys (optional)', { exact: true }).fill('plan\norderId');
  await expect(dialog.getByLabel('Tool identity (optional)', { exact: true })).toBeVisible();
  // Signed-in users could be verified with a JWKS URL: the form shows that shape's own fields only when chosen.
  await dialog.getByLabel('User token verification (optional)', { exact: true }).selectOption({ label: 'JWKS (identity provider keys)' });
  await expect(dialog.getByLabel('JWKS URL', { exact: true })).toBeVisible();
  await dialog.getByLabel('User token verification (optional)', { exact: true }).selectOption('');
  await expect(dialog.getByLabel('JWKS URL', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add channel' }).click();

  // The secret key is shown once, right after creation, with a copy button.
  const saved = page.getByRole('dialog', { name: 'App chat saved' });
  const secretKey = ((await saved.getByLabel('Secret key (shown once)', { exact: true }).textContent()) ?? '').trim();
  expect(secretKey).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
  await saved.getByRole('button', { name: 'Copy Secret key' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secretKey);
  const publishableKey = ((await saved.getByLabel('Publishable key', { exact: true }).textContent()) ?? '').trim();
  expect(publishableKey).toMatch(/^[A-Za-z0-9_-]{16}$/);
  // Embed panel in client mode: no script tag (the hosted widget cannot fetch session passes), so it opens on
  // React; then React Native and the server-side pass minting (never the secret itself).
  await expect(saved.getByRole('tab', { name: 'Script tag' })).toHaveCount(0);
  await expect(saved.getByRole('tab', { name: 'React', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(saved.getByLabel('React snippet', { exact: true })).toContainText('getSessionPass');
  await saved.getByRole('tab', { name: 'React Native' }).click();
  await expect(saved.getByLabel('React Native snippet', { exact: true })).toContainText('@winsendotai/ocso-chat-react/native');
  await saved.getByRole('tab', { name: 'Server' }).click();
  const server = saved.getByLabel('Server snippet', { exact: true });
  await expect(server).toContainText(`/public/webchat/${publishableKey}/session-pass`);
  await expect(server).toContainText('process.env.OCSO_SECRET_KEY');
  await expect(server).not.toContainText(secretKey);
  await saved.getByRole('button', { name: 'Done' }).click();

  // Never shown again: not on the card, not in the edit dialog.
  const cards = page.getByRole('list', { name: 'Channels' });
  const card = cards.getByRole('listitem', { name: 'App chat' });
  await expect(card).toContainText(`publishable key${publishableKey}`);
  await cards.getByRole('link', { name: 'Edit App chat' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit App chat' });
  await expect(dialog.getByLabel('Auth mode (optional)', { exact: true })).toHaveValue('client');
  await expect(dialog.locator('label[for="ch-sec-secretKey"] .cred-state')).toHaveText('set');
  expect(await page.content()).not.toContain(secretKey);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Live after a Head's approval; the copied key then mints session passes server-to-server.
  await card.getByRole('button', { name: 'Activate App chat' }).click();
  await submitForApproval(page, 'E2E: open the app chat');
  await approveAsLead('channel', 'Activate channel App chat');
  await page.reload();
  await expect(card).toContainText('live');
  const minted = await mintPass(publishableKey, secretKey);
  expect(minted.status).toBe(201);
  const { sessionPass } = (await minted.json()) as { sessionPass: string };
  const opened = await fetch(`${apiUrl}/public/webchat/${publishableKey}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionPass }) });
  expect(opened.status).toBe(200);
  const anonymous = await fetch(`${apiUrl}/public/webchat/${publishableKey}/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://app.example.com' }, body: '{}' });
  expect(anonymous.status).toBe(401);

  // Rotation: a new key generated in the browser, shown once, applied when the Head approves the change.
  await cards.getByRole('link', { name: 'Edit App chat' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit App chat' });
  await dialog.getByRole('button', { name: 'Rotate secret key' }).click();
  const rotated = ((await dialog.getByLabel('Generated Secret key', { exact: true }).textContent()) ?? '').trim();
  expect(rotated).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
  expect(rotated).not.toBe(secretKey);
  await dialog.getByRole('button', { name: 'Submit change' }).click();
  await submitForApproval(page, 'E2E: rotate the app chat secret key');
  await expect(dialog).toContainText('Sent for approval');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await mintPass(publishableKey, secretKey)).status).toBe(201); // unchanged until approved
  await approveAsLead('channel', 'Change channel App chat');
  expect((await mintPass(publishableKey, secretKey)).status).toBe(401);
  expect((await mintPass(publishableKey, rotated)).status).toBe(201);
});
