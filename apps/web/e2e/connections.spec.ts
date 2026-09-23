import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS } from './config';
import { DEMO_PORT, DEMO_TOKEN, FAKE_KEY, USERS, approveAsLead, seedConnectionsStack, submitForApproval } from './connections-setup';
import { login, logout, settled } from './helpers';

/**
 * Connections & models (design/04) against the real API: providers (incl. the
 * dev-only scripted provider), a profile with a fallback, pricing, the MCP
 * add-server wizard against the example MCP server, OAuth return banners and
 * role gating. Run with OCSO_ENABLE_DEV_PROVIDERS=true, e.g.
 *   OCSO_ENABLE_DEV_PROVIDERS=true E2E_API_PORT=4420 E2E_WEB_PORT=3420 E2E_DB_NAME=ocso_e2e_conn npx playwright test e2e/connections
 */
test.describe.configure({ mode: 'serial' });

seedConnectionsStack({ mcpDemo: true });

const card = (page: Page, name: string) => page.getByRole('list', { name: 'Model providers' }).getByRole('listitem', { name, exact: true });

test('Tech admin configures providers: every kind is listed, credentials stay write-only, tests report cleanly', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=providers');
  await settled(page);
  const grid = page.getByRole('list', { name: 'Model providers' });
  for (const kind of ['AWS Bedrock', 'Google Vertex AI', 'Microsoft Foundry', 'OpenAI API', 'Anthropic API', 'Sarvam AI', 'Scripted model (development only)']) {
    await expect(grid.getByRole('listitem', { name: kind, exact: true })).toContainText('not configured');
  }
  // Mark and caching line come from the provider definition (GET /v1/model-providers/kinds), not from the web app.
  const bedrock = grid.getByRole('listitem', { name: 'AWS Bedrock', exact: true });
  await expect(bedrock.locator('.logo')).toHaveText('AWS');
  await expect(bedrock).toContainText('cachePoint breakpoints (Claude, Nova)');

  await card(page, 'Scripted model (development only)').getByRole('link', { name: 'Configure' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add model provider' });
  await expect(dialog.getByLabel('Provider', { exact: true })).toHaveValue('DEV_SCRIPTED');
  await dialog.getByLabel('Name', { exact: true }).fill('Scripted');
  await dialog.getByLabel('Region (optional)').fill('ap-south-1');
  await dialog.getByLabel('Data residency zone (optional)').fill('IN');
  await dialog.getByLabel('Latency ms (optional)').fill('0');
  await expect(dialog).toContainText('This provider needs no credentials.');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog).toBeHidden();
  // A new provider is a disabled draft: enabling it is a second person's approval (PM/research/11 §4).
  await expect(card(page, 'Scripted')).toContainText('disabled');
  await expect(card(page, 'Scripted')).toContainText('development only');
  await card(page, 'Scripted').getByRole('button', { name: 'Enable Scripted' }).click();
  await submitForApproval(page, 'E2E: the scripted provider');
  await expect(card(page, 'Scripted')).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('model_provider', 'Enable model provider Scripted');
  await page.reload();
  await expect(card(page, 'Scripted')).toContainText('untested');

  await card(page, 'Scripted').getByRole('button', { name: 'Test' }).click();
  await expect(card(page, 'Scripted').getByRole('status')).toContainText('test passed');
  await expect(card(page, 'Scripted')).toContainText('connected');

  await page.getByRole('link', { name: 'Add provider' }).click();
  dialog = page.getByRole('dialog', { name: 'Add model provider' });
  await dialog.getByLabel('Provider', { exact: true }).selectOption({ label: 'OpenAI API' });
  await dialog.getByLabel('Name', { exact: true }).fill('OpenAI');
  await dialog.getByLabel('Region (optional)').fill('global');
  // Unreachable local endpoint: the test call must fail without touching the real network.
  await dialog.getByLabel('Base URL (optional)').fill('https://127.0.0.1:9/v1');
  await dialog.getByLabel('Health model (optional)').fill('gpt-5.5');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog.getByText('Required', { exact: true })).toBeVisible();
  await dialog.getByLabel('Api key').fill(FAKE_KEY);
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, 'OpenAI')).toContainText('api key set');

  await card(page, 'OpenAI').getByRole('link', { name: 'Edit' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit OpenAI' });
  await expect(dialog.getByLabel('Api key')).toHaveValue('');
  await expect(dialog.locator('label[for="pv-cred-apiKey"] .cred-state')).toHaveText('set');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // A draft can be tested before anyone approves it (it stays disabled: nothing calls it meanwhile).
  await card(page, 'OpenAI').getByRole('button', { name: 'Test' }).click();
  await expect(card(page, 'OpenAI').getByRole('status')).toContainText('test failed', { timeout: 30_000 });
  await expect(card(page, 'OpenAI')).toContainText('disabled');
  await card(page, 'OpenAI').getByRole('button', { name: 'Enable OpenAI' }).click();
  await submitForApproval(page, 'E2E: OpenAI as a fallback');
  await approveAsLead('model_provider', 'Enable model provider OpenAI');
  await page.reload();
  await expect(card(page, 'OpenAI')).toContainText('down');
  await expect(card(page, 'OpenAI')).toContainText('last error');
  expect(await page.content()).not.toContain(FAKE_KEY);
});

test('Tech admin creates a profile with a fallback after the policy check, and sees caching per target', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=providers');
  await page.getByRole('link', { name: 'New model profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'New logical model profile' });
  await expect(dialog.getByRole('button', { name: 'Create profile' })).toBeDisabled();
  await dialog.getByLabel('Profile name').fill('support-primary');
  await dialog.getByLabel('Provider', { exact: true }).selectOption({ label: 'Scripted · Scripted model (development only) · ap-south-1' });
  // The model picker lists what the provider offers (GET /v1/model-providers/:id/models).
  const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await model.click();
  await dialog.getByRole('listbox', { name: 'Scripted models' }).getByRole('option', { name: /^scripted-1/ }).click();
  await expect(model).toHaveValue('scripted-1');
  await dialog.getByRole('button', { name: 'Add fallback' }).click();
  await dialog.getByLabel('Fallback 1 provider').selectOption({ label: 'OpenAI · OpenAI API · global' });
  // OpenAI points at an unreachable endpoint: the listing error is shown and free text still works.
  await expect(dialog.getByText(/Could not list OpenAI models/)).toBeVisible({ timeout: 30_000 });
  await dialog.getByLabel('Fallback 1 model').fill('gpt-5.5');
  await dialog.getByLabel('Cache TTL').selectOption('1h');
  await dialog.getByRole('checkbox', { name: 'Image input' }).check();

  const check = dialog.getByRole('region', { name: 'Policy check' });
  await expect(check).toContainText('Policy check passed.');
  await expect(check).toContainText('cross-provider fallback is disabled by deployment policy');
  const targets = check.getByRole('table', { name: 'Targets and prompt caching' });
  await expect(targets.getByRole('row').nth(1)).toContainText('explicit');
  await expect(targets.getByRole('row').nth(1)).toContainText('breakpoints · 1h TTL');
  await expect(targets.getByRole('row').nth(2)).toContainText('key-based');
  await expect(targets.getByRole('row').nth(2)).toContainText('cache key · 24h retention');

  await dialog.getByRole('button', { name: 'Create profile' }).click();
  await expect(dialog).toBeHidden();
  // Saving priced the OpenAI fallback from the model catalog (DEV_SCRIPTED is never priced).
  const saved = page.getByRole('dialog', { name: 'Saved support-primary' });
  await expect(saved.getByRole('listitem').filter({ hasText: 'gpt-5.5' })).toContainText('price added from models.dev');
  await saved.getByRole('button', { name: 'Done' }).click();
  await expect(saved).toBeHidden();
  const profiles = page.getByRole('table', { name: 'Logical model profiles' });
  await expect(profiles.getByRole('row', { name: /support-primary/ })).toContainText('OpenAI');
  await expect(profiles.getByRole('row', { name: /support-primary/ })).toContainText('prefix · 1h · explicit / key-based');
  await expect(card(page, 'OpenAI')).toContainText('fallback for support-primary');
});

test('Tech admin adds a model price and overrides a catalog price', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=providers');
  const table = page.getByRole('table', { name: 'Model pricing' });
  // The catalog row the profile save added: origin and source are shown.
  await expect(table.getByRole('row', { name: /gpt-5\.5/ })).toContainText('catalog');
  await expect(table.getByRole('row', { name: /gpt-5\.5/ })).toContainText('models.dev');
  await expect(page.getByRole('region', { name: /Models in use without a price/ })).toContainText('Every model in use has a price');

  await page.getByRole('link', { name: 'Add price' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add model price' });
  await dialog.getByLabel('Provider').selectOption({ label: 'OpenAI API' });
  await dialog.getByLabel('Model', { exact: true }).fill('gpt-private-ft');
  await dialog.getByLabel('Input per 1M tokens').fill('1.25');
  await dialog.getByLabel('Output per 1M tokens').fill('10');
  await dialog.getByLabel('Cache read per 1M tokens (optional)').fill('0.125');
  await dialog.getByRole('button', { name: 'Add price' }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole('row', { name: /gpt-private-ft/ })).toContainText('1.25 USD');
  await expect(table.getByRole('row', { name: /gpt-private-ft/ })).toContainText('0.125 USD');
  await expect(table.getByRole('row', { name: /gpt-private-ft/ })).toContainText('manual');
  // A price a person enters is a draft that prices nothing until a second person approves it.
  await expect(table.getByRole('row', { name: /gpt-private-ft/ }).getByRole('button', { name: /^Apply price/ })).toBeVisible();

  // The catalog price is live: editing it is a proposal (the modal asks for the checker).
  await table.getByRole('link', { name: 'gpt-5.5' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit price · gpt-5.5' });
  await expect(dialog).toContainText('Saving an edit makes it a manual price');
  await dialog.getByLabel('Output per 1M tokens').fill('12');
  await dialog.getByRole('button', { name: 'Save price' }).click();
  await submitForApproval(page, 'E2E: negotiated price');
  await expect(dialog).toContainText('Sent for approval');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(table.getByRole('row', { name: /gpt-5\.5/ })).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('model_pricing', 'gpt-5.5');
  await page.reload();
  await expect(table.getByRole('row', { name: /gpt-5\.5/ })).toContainText('12.00 USD');
  await expect(table.getByRole('row', { name: /gpt-5\.5/ })).toContainText('manual');
});

test('Tech admin adds the example MCP server: discover → authenticate → classify → approve → healthy', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=mcp');
  await page.getByRole('link', { name: 'Add MCP server' }).first().click();
  const wizard = page.getByRole('dialog', { name: 'Add MCP server' });
  await wizard.getByLabel('MCP server URL').fill(`http://127.0.0.1:${DEMO_PORT}/mcp`);
  await wizard.getByLabel('Connection name').fill('meridian-core');
  await wizard.getByLabel('Network').selectOption('INTERNAL');
  await wizard.getByRole('button', { name: 'Discover server' }).click();

  await expect(wizard).toContainText('The server requires authentication.');
  await wizard.getByRole('button', { name: 'Authenticate' }).click();
  await expect(wizard).not.toContainText('Continue with OAuth'); // the demo server publishes no OAuth metadata
  await wizard.getByLabel('Header name').fill('Authorization');
  await wizard.getByLabel('Credential value').fill(`Bearer ${DEMO_TOKEN}`);
  await wizard.getByRole('button', { name: 'Save credential and discover' }).click();

  await expect(wizard).toContainText('7 tools');
  const reverse = wizard.locator('[data-tool="payments.reverse_transaction"]');
  await expect(reverse.getByLabel('Side-effect class of payments.reverse_transaction')).toHaveValue('SENSITIVE');
  for (const box of await wizard.getByRole('checkbox', { name: /^Approve / }).all()) await box.check();
  await wizard.getByRole('button', { name: 'Review approval' }).click();

  await expect(wizard).toContainText('This grants any agent a Lead enables it for access to 7 meridian-core tools.');
  // Taking it live is a second person's approval; the worker then re-contacts the server before it goes live.
  await wizard.getByRole('button', { name: 'Approve and connect' }).click();
  await submitForApproval(page, 'E2E: core banking for agents');
  await expect(wizard.getByRole('heading', { name: 'meridian-core is not approved yet' })).toBeVisible();
  await wizard.getByRole('button', { name: 'Done' }).click();
  await expect(wizard).toBeHidden();
  await approveAsLead('mcp_connection', 'Activate MCP connection meridian-core');
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('table', { name: 'MCP connections' }).getByRole('row', { name: /meridian-core/ })).toContainText(/healthy|active/, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Open meridian-core' }).click();
  const opened = page.getByRole('dialog', { name: 'meridian-core' });
  await opened.getByRole('button', { name: 'Check health' }).click();
  await expect(opened.getByRole('status').first()).toContainText('Health: healthy');
  await page.goto('/connections?tab=mcp');

  const row = page.getByRole('table', { name: 'MCP connections' }).getByRole('row', { name: /meridian-core/ });
  await expect(row).toContainText('7/7');
  await expect(row).toContainText('header · Authorization');
  await expect(row).toContainText('healthy');
  expect(await page.content()).not.toContain(DEMO_TOKEN);
});

test('connection details: health history, disable/enable with confirmation, OAuth return banners', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=mcp');
  await page.getByRole('link', { name: 'Open meridian-core' }).click();
  const drawer = page.getByRole('dialog', { name: 'meridian-core' });
  await expect(drawer.getByRole('table', { name: 'Recent health checks' })).toContainText('healthy');
  await expect(drawer.locator('[data-tool="crm.get_customer"]')).toBeVisible();

  const confirm = page.getByRole('dialog', { name: 'Disable meridian-core' });
  // The drawer is server-rendered: retry until hydration has attached the handler.
  await expect(async () => {
    await drawer.getByRole('button', { name: 'Disable' }).click();
    await expect(confirm).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(confirm).toContainText('recorded in the audit log');
  await confirm.getByRole('button', { name: 'Disable connection' }).click();
  await expect(confirm).toBeHidden();
  await expect(drawer).toContainText('disabled');
  // Re-enabling is a proposal (disabling was immediate); the worker re-contacts the server, then it is live.
  await drawer.getByRole('button', { name: 'Re-enable meridian-core' }).click();
  await submitForApproval(page, 'E2E: back on');
  await approveAsLead('mcp_connection', 'Re-enable MCP connection meridian-core');
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'meridian-core' })).not.toContainText('disabled', { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  const id = new URL(page.url()).searchParams.get('connection');
  expect(id).toBeTruthy();
  // The public callback (proxied to the API) rejects a forged state and redirects back with a stable code only.
  await page.goto('/oauth/mcp/callback?state=forged-state&code=abc');
  await page.waitForURL(/oauth=error/);
  await expect(page.getByRole('alert').filter({ hasText: 'Authorization failed.' })).toContainText('did not match a pending request');
  await page.goto(`/connections?tab=mcp&connection=${id}&oauth=ok`);
  await expect(page.getByRole('status').filter({ hasText: 'Authorization complete for meridian-core.' })).toBeVisible();
});

test('Service member sees only My connections; Lead reads providers and MCP without admin controls', async ({ page }) => {
  await login(page, USERS.exec);
  await page.goto('/connections?tab=providers');
  await settled(page);
  const tabs = page.getByRole('tablist', { name: 'Connection types' });
  await expect(tabs.getByRole('tab')).toHaveText(['My connections']);
  await expect(page.getByRole('heading', { name: 'My connections' })).toBeVisible();
  for (const control of ['New model profile', 'Add MCP server', 'Add provider', 'Test', 'Edit']) {
    await expect(page.getByRole('button', { name: control, exact: true }).or(page.getByRole('link', { name: control, exact: true }))).toHaveCount(0);
  }
  await expect(page.getByText('Nothing published for personal use yet')).toBeVisible();
  await logout(page);

  await login(page, USERS.lead);
  await page.goto('/connections?tab=providers');
  await settled(page);
  await expect(card(page, 'Scripted')).toContainText('connected');
  await expect(card(page, 'Scripted').getByRole('button', { name: 'Test' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New model profile' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Model pricing' })).toHaveCount(0);
  await page.getByRole('table', { name: 'Logical model profiles' }).getByRole('link', { name: /support-primary/ }).click();
  const view = page.getByRole('dialog', { name: 'support-primary' });
  await expect(view).toContainText('read only');
  await expect(view.getByRole('table', { name: 'Targets and prompt caching' })).toContainText('key-based');
  await view.getByRole('button', { name: 'Close dialog' }).click();

  await page.goto('/connections?tab=mcp');
  await expect(page.getByRole('table', { name: 'MCP connections' })).toContainText('meridian-core');
  await expect(page.getByRole('link', { name: 'Add MCP server' })).toHaveCount(0);
});

test('Tech admin deletes the MCP connection through an approval', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=mcp');
  await page.getByRole('link', { name: 'Open meridian-core' }).click();
  await page.getByRole('dialog', { name: 'meridian-core' }).getByRole('button', { name: 'Delete meridian-core' }).click();
  await submitForApproval(page, 'E2E: retire the connection');
  await approveAsLead('mcp_connection', 'Delete MCP connection meridian-core');
  await page.goto('/connections?tab=mcp');
  await expect(page.getByRole('table', { name: 'MCP connections' })).toHaveCount(0);
  await expect(page.getByText('No MCP servers connected yet')).toBeVisible();
});

test('Tech admin adds a webhook (secret shown once) and sees every credential by reference only', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/connections?tab=webhooks');
  await page.getByRole('link', { name: 'Add endpoint' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add webhook endpoint' });
  await dialog.getByLabel('Name').fill('crm-events');
  await dialog.getByLabel('Endpoint URL').fill('https://127.0.0.1:9/ocso-events');
  await dialog.getByRole('checkbox', { name: 'conversation.*' }).check();
  await dialog.getByRole('button', { name: 'Create endpoint' }).click();
  const created = page.getByRole('dialog', { name: 'Webhook crm-events created' });
  await expect(created).toContainText('You won’t see this again');
  const secret = (await created.getByLabel('Signing secret', { exact: true }).textContent()) ?? '';
  expect(secret).toMatch(/^whsec_/);
  await created.getByRole('button', { name: 'Done' }).click();
  await expect(created).toBeHidden();

  const table = page.getByRole('table', { name: 'Webhooks' });
  await expect(table.getByRole('row', { name: /crm-events/ })).toContainText('conversation.*');
  // A new subscription is a disabled draft until a second person approves enabling it.
  await expect(table.getByRole('row', { name: /crm-events/ })).toContainText('draft');
  await expect(table.getByRole('row', { name: /crm-events/ }).getByRole('button', { name: 'Enable crm-events' })).toBeVisible();
  await table.getByRole('link', { name: /127\.0\.0\.1:9\/ocso-events/ }).click();
  dialog = page.getByRole('dialog', { name: 'Webhook · crm-events' });
  await dialog.getByRole('button', { name: 'Send test' }).click();
  await expect(dialog.getByRole('status').first()).toContainText('Test failed', { timeout: 30_000 });
  await expect(dialog.getByRole('table', { name: 'Recent deliveries' }).or(dialog.getByText('No deliveries yet'))).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  await page.goto('/connections?tab=secrets');
  const secrets = page.getByRole('table', { name: 'Secrets' });
  await expect(secrets).toContainText('provider:OpenAI');
  await expect(secrets).toContainText('webhook:crm-events');
  const html = await page.content();
  for (const value of [secret, FAKE_KEY, DEMO_TOKEN]) expect(html).not.toContain(value);

  await page.getByRole('button', { name: 'Rotate key' }).click();
  const rotate = page.getByRole('dialog', { name: 'Rotate the customer-claims signing key' });
  await rotate.getByRole('button', { name: 'Rotate key' }).click();
  await expect(rotate).toBeHidden();
  await expect(page.getByRole('table', { name: 'Signing keys' })).toContainText('active');
});
