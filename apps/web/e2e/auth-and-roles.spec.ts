import { expect, test } from '@playwright/test';
import { ACCOUNTS, E2E } from './config';
import { createUser, expectNavLinksResolve, login, logout, navModel, settled } from './helpers';

/**
 * One serial story on a fresh database: first-run setup → Tech Admin →
 * CS Lead → CS Exec, asserting the role-specific navigation of
 * design/OCSONav.dc.html at each step.
 */
test.describe.configure({ mode: 'serial' });

const TEAM = 'Cards & EMI · Tier 2';

test('first-run setup creates the Platform Tech Admin', async ({ page }) => {
  await page.goto('/login');
  await page.waitForURL('**/setup'); // no users yet → login forwards to setup
  await expect(page.getByRole('heading', { name: 'Set up OCSO' })).toBeVisible();

  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByText('The setup token is at least 16 characters')).toBeVisible();

  await page.getByLabel('Setup token').fill('wrong-token-wrong-token');
  await page.getByLabel('Organization name').fill('E2E Bank');
  await page.getByLabel('Your name').fill(ACCOUNTS.admin.name);
  await page.getByLabel('Work email').fill(ACCOUNTS.admin.email);
  await page.getByLabel('Password').fill(ACCOUNTS.admin.password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Setup token is not valid' })).toBeVisible();

  await page.getByLabel('Setup token').fill(E2E.setupToken);
  await page.getByLabel('Password').fill(ACCOUNTS.admin.password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await page.waitForURL('**/login?setup=done');
  await expect(page.getByText('Setup complete.')).toBeVisible();

  // Setup is one-time: the page now forwards to sign-in.
  await page.goto('/setup');
  await page.waitForURL('**/login');
});

test('sign-in shows API errors, then the admin sees Platform navigation and not My work', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(ACCOUNTS.admin.email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password' })).toBeVisible();

  await login(page, ACCOUNTS.admin);
  const nav = await navModel(page);
  expect(nav.groups).toEqual(['Platform', 'Integrations', 'Oversight']);
  expect(nav.items).toEqual([
    'Home', 'Search',
    'System', 'Workers', 'Queues & leases', 'Telemetry',
    'Models', 'Connections', 'Channels', 'Secrets', 'Webhooks',
    'Alerts', 'Virtual agents', 'Audit log', 'Team & roles',
    'Settings',
  ]);
  expect(nav.groups).not.toContain('My work');

  await expect(page.locator('.greeting h1')).toContainText('Tara,');
  await expect(page.getByText('E2E Bank · PROD'.toUpperCase())).toBeVisible();
  // Nothing invented: metric tiles without an API say so.
  await expect(page.locator('.tile.nodata').first()).toContainText('no data yet');
  // Worker limits are real (GET /v1/settings/workers).
  await expect(page.getByRole('region', { name: 'Capacity' })).toContainText('10 workers');

  await expectNavLinksResolve(page);
});

test('admin creates a CS Lead from Team & roles', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team & roles' })).toBeVisible();
  await page.getByRole('button', { name: 'New user' }).click();
  const roles = await page.getByRole('dialog', { name: 'New user' }).getByLabel('Role').locator('option').allTextContents();
  expect(roles).toEqual(['Platform Tech Admin', 'CS Lead', 'CS Exec']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await createUser(page, { ...ACCOUNTS.lead, role: 'CS_LEAD' });
  await expect(page.getByRole('status').filter({ hasText: `Created ${ACCOUNTS.lead.name} · CS Lead` })).toBeVisible();
  await logout(page);
});

test('CS Lead sees Operations / Quality / Governance and can create only CS Execs', async ({ page }) => {
  await login(page, ACCOUNTS.lead);
  const nav = await navModel(page);
  expect(nav.groups).toEqual(['Operations', 'Quality', 'Governance']);
  expect(nav.items).toEqual([
    'Home', 'Search',
    'Conversations', 'Virtual agents', 'Queues', 'Customers',
    'Analytics', 'Reviews', 'Prompt corrections', 'Escalation reasons',
    'Alerts', 'SLA policies', 'Team',
    'Settings',
  ]);
  await expectNavLinksResolve(page);

  await page.goto('/team');
  await page.getByRole('button', { name: 'New team' }).click();
  await page.getByLabel('Team name').fill(TEAM);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('table', { name: 'Teams' }).getByText(TEAM)).toBeVisible();

  await page.getByRole('button', { name: 'New user' }).click();
  const roles = await page.getByRole('dialog', { name: 'New user' }).getByLabel('Role').locator('option').allTextContents();
  expect(roles).toEqual(['CS Exec']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await createUser(page, { ...ACCOUNTS.exec, team: TEAM });
  await logout(page);
});

test('CS Exec sees My work only, cannot open Team, and returns to the requested page after sign-in', async ({ page }) => {
  await page.goto('/settings');
  await page.waitForURL('**/login?next=%2Fsettings');
  await login(page, ACCOUNTS.exec, '/settings');

  const nav = await navModel(page);
  expect(nav.groups).toEqual(['My work']);
  expect(nav.items).toEqual(['Home', 'Search', 'Conversations', 'Pickup queue', 'Customers', 'Alerts', 'Settings']);
  await expect(page.locator('.scope-sw')).toContainText(TEAM);
  await expectNavLinksResolve(page);

  await page.goto('/team');
  await expect(page.getByText('Not available for your role')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('region', { name: 'Deployment settings' })).toContainText('E2E Bank');
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
});

test('Ask OCSO opens with Ctrl+J and says the internal agent is not available yet', async ({ page }) => {
  await login(page, ACCOUNTS.exec);
  await settled(page);
  await page.keyboard.press('Control+j');
  const drawer = page.getByRole('dialog', { name: 'Ask OCSO' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('scope · my conversations');
  await expect(drawer).toContainText('role: cs exec');

  await drawer.getByRole('button', { name: 'What needs my attention right now?' }).click();
  await expect(drawer.getByText('The internal agent is not available yet.')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: /Ask OCSO/ }).first().click();
  await expect(drawer).toBeVisible();
});

test('Tech Admin saves deployment settings', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/settings');
  await page.getByLabel('Region label').fill('ap-south-1');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Deployment settings saved')).toBeVisible();
  await expect(page.locator('.sb-brand .region')).toHaveText('ap-south-1');
});

test('logout clears the session so app routes go back to sign-in', async ({ page, context }) => {
  await login(page, ACCOUNTS.admin);
  expect((await context.cookies()).some((c) => c.name === 'ocso_session' && c.httpOnly)).toBe(true);
  await logout(page);
  expect((await context.cookies()).some((c) => c.name === 'ocso_session')).toBe(false);
  await page.goto('/team');
  await page.waitForURL('**/login?next=%2Fteam');
});
