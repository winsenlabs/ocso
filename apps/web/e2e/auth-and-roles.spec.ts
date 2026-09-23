import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { acceptInvite, createUser, expectNavLinksResolve, login, logout, navModel, settled } from './helpers';
import { totp } from './totp';

/**
 * One serial story on a fresh database: first-run setup → Tech admin →
 * invites a Lead → Lead invites a Service member, asserting the role-specific
 * navigation of design/OCSONav.dc.html at each step; then MFA enrolment when
 * the Tech admin requires it, and a forgotten password (ADR-025).
 */
test.describe.configure({ mode: 'serial' });

const TEAM = 'Cards & EMI · Tier 2';

test('first-run setup creates the Tech admin', async ({ page }) => {
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
    'Models', 'Connections', 'Channels', 'Message templates', 'Secrets', 'Webhooks',
    'Alerts', 'Virtual agents', 'Audit log', 'Routers', 'Team & roles', 'Approvals', 'Exceptions',
    'My connections',
    'Settings',
  ]);
  expect(nav.groups).not.toContain('My work');

  await expect(page.locator('.greeting h1')).toContainText('Tara,');
  // One deployment, one environment: no scope box and no environment badge in the chrome.
  await expect(page.locator('.scope-sw')).toHaveCount(0);
  await expect(page.getByText(/E2E BANK · PROD/)).toHaveCount(0);
  // A new deployment: Home shows what is left to set up instead of tiles with no data.
  const setup = page.getByRole('region', { name: 'Set up OCSO' });
  await expect(setup).toBeVisible();
  await expect(setup.getByRole('link', { name: /Connect a model provider/ })).toHaveAttribute('href', '/connections?tab=providers');
  await expect(setup).toContainText(/\d of \d done/);
  // Tech cannot create agents: that step names who can instead of linking to a page Tech cannot act on.
  await expect(setup.getByRole('link', { name: /Create your first agent/ })).toHaveCount(0);
  await expect(setup.getByText('Create your first agent')).toContainText('waiting on Head');
  await expect(page.getByRole('list', { name: /Key numbers/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  // Tech: the compact health strip, and no Ask OCSO bar until a model is chosen for it.
  await expect(page.getByRole('list', { name: 'Platform health' })).toContainText('workers');
  await expect(page.getByRole('search', { name: 'Ask OCSO a question' })).toHaveCount(0);
  // Worker limits are real (GET /v1/settings/workers).
  await expect(page.getByRole('region', { name: 'Capacity' })).toContainText('10 workers');

  await expectNavLinksResolve(page);
});

test('admin creates a Head (the lead account) from Team & roles', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/team');
  await expect(page.getByRole('heading', { name: 'Team & roles' })).toBeVisible();
  await page.getByRole('button', { name: 'New user' }).click();
  const roles = await page.getByRole('dialog', { name: 'New user' }).getByLabel('Role').locator('option').allTextContents();
  expect(roles).toEqual(['Tech', 'Head', 'Lead', 'Service']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await createUser(page, { ...ACCOUNTS.lead, role: 'HEAD' });
  await expect(page.getByRole('status').filter({ hasText: `Invited ${ACCOUNTS.lead.name} · Head` })).toBeVisible();
  await logout(page);
});

test('the Head sees Operations / Quality / Governance and creates only presets within their own rights', async ({ page }) => {
  await login(page, ACCOUNTS.lead);
  const nav = await navModel(page);
  expect(nav.groups).toEqual(['Operations', 'Quality', 'Governance']);
  expect(nav.items).toEqual([
    'Home', 'Search',
    'Conversations', 'Virtual agents', 'Queues', 'Routers', 'Customers', 'Message templates',
    'Analytics', 'Reviews', 'Prompt corrections', 'Escalation reasons',
    'Alerts', 'SLA policies', 'Team', 'Approvals', 'Exceptions',
    'My connections',
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
  // Containment (PM/research/11 §3.4): presets whose rights fit inside the Head's own.
  expect(roles).toEqual(['Head', 'Lead', 'Service']);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await createUser(page, { ...ACCOUNTS.exec, role: 'SERVICE', team: TEAM });
  await logout(page);
});

test('Service member sees My work only, cannot open Team, and returns to the requested page after sign-in', async ({ page }) => {
  await page.goto('/settings');
  await page.waitForURL('**/login?next=%2Fsettings');
  await login(page, ACCOUNTS.exec, '/settings');

  const nav = await navModel(page);
  expect(nav.groups).toEqual(['My work']);
  expect(nav.items).toEqual(['Home', 'Search', 'Conversations', 'Pickup queue', 'Customers', 'Alerts', 'My connections', 'Settings']);
  await expectNavLinksResolve(page);

  // Service Home: needs you, take next (nothing waiting yet), my shift; team names are not in the chrome.
  await page.goto('/');
  await settled(page);
  await expect(page.locator('.scope-sw')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My queue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take next conversation' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'My shift' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Set up OCSO' })).toHaveCount(0);
  await expect(page.getByText(TEAM)).toHaveCount(0);

  await page.goto('/team');
  await expect(page.getByText('Not available for your role')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('region', { name: 'Deployment settings' })).toContainText('E2E Bank');
  await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
});

test('Ask OCSO opens with Ctrl+J and says it is not set up yet', async ({ page }) => {
  await login(page, ACCOUNTS.exec);
  await settled(page);
  await page.keyboard.press('Control+j');
  const drawer = page.getByRole('dialog', { name: 'Ask OCSO' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('scope · my conversations');
  await expect(drawer).toContainText('role: service');

  // No model profile chosen for the internal agent yet (full flow: internal-agent.spec.ts).
  await expect(drawer.getByText('Ask OCSO is not set up yet.')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: /Ask OCSO/ }).first().click();
  await expect(drawer).toBeVisible();
});

test('Tech admin saves deployment settings', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/settings');
  await page.getByLabel('Region label').fill('ap-south-1');
  // Settings are always live, so the change is a proposal a Head approves (PM/research/11 §4).
  const form = page.getByRole('form', { name: 'Deployment settings' });
  await form.getByLabel('Checker').selectOption({ label: ACCOUNTS.lead.name });
  await form.getByLabel('Reason').fill('E2E: name the region');
  await form.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText(`Sent for approval to ${ACCOUNTS.lead.name}`)).toBeVisible();
  await approveSettingsAs(ACCOUNTS.lead);
  await page.reload();
  await expect(page.locator('.sb-brand .region')).toHaveText('ap-south-1');
});

test('logout clears the session so app routes go back to sign-in', async ({ page, context }) => {
  await login(page, ACCOUNTS.admin);
  expect((await context.cookies()).some((c) => c.name === 'ocso.session_token' && c.httpOnly && c.sameSite === 'Lax')).toBe(true);
  await logout(page);
  expect((await context.cookies()).some((c) => c.name === 'ocso.session_token')).toBe(false);
  await page.goto('/team');
  await page.waitForURL('**/login?next=%2Fteam');
});

/** Reads the setup key shown next to the QR code and answers with the current code. */
async function enrolAuthenticator(page: Page, password: string): Promise<string> {
  await page.getByLabel('Current password').fill(password);
  await page.getByRole('button', { name: 'Set up authenticator app' }).click();
  const secret = (await page.getByLabel('Setup key').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  await page.getByLabel('6-digit code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify and turn on' }).click();
  await expect(page.getByText('Two-factor authentication is on.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Backup codes' }).getByRole('listitem')).toHaveCount(10);
  return secret;
}

/**
 * Settings change through approvals (PM/research/11 §4). The checker is a second Tech: Heads hold the platform
 * check permission too, but once MFA is required for Heads a password-only Head could not approve lifting it.
 */
const MFA_CHECKER = { name: 'Mona Tech', email: 'mona.tech@e2e.ocso.test', password: 'correct-horse-battery-monatech' };
async function apiFetch(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return fetch(`${apiUrl}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function apiToken(email: string, password: string): Promise<string> {
  return ((await (await apiFetch('POST', '/v1/auth/login', { email, password })).json()) as { token: string }).token;
}
async function ensureMfaChecker(): Promise<void> {
  const admin = await apiToken(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  const res = await apiFetch('POST', '/v1/users', { name: MFA_CHECKER.name, email: MFA_CHECKER.email, role: 'TECH', password: MFA_CHECKER.password }, admin);
  expect([201, 409]).toContain(res.status);
}
async function approveSettingsAs(who: { email: string; password: string }): Promise<void> {
  const token = await apiToken(who.email, who.password);
  const rows = ((await (await apiFetch('GET', '/v1/approvals?box=AWAITING_ME&objectKind=deployment_settings', undefined, token)).json()) as { rows: Array<{ id: string; contentHash: string }> }).rows;
  expect(rows.length).toBeGreaterThan(0);
  const res = await apiFetch('POST', `/v1/approvals/${rows[0]!.id}/decision`, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: rows[0]!.contentHash }, token);
  expect(res.status).toBe(200);
}

test('Tech admin requires MFA for Heads: the lead (a Head) enrols at sign-in, then signs in with a code', async ({ page }) => {
  await ensureMfaChecker();
  await login(page, ACCOUNTS.admin);
  await page.goto('/settings');
  const policy = page.getByRole('form', { name: 'Require MFA for roles' });
  await policy.getByLabel('Head', { exact: true }).check();
  // A settings change is a proposal (PM/research/11 §4): another Head approves it before it applies.
  await policy.getByLabel('Checker').selectOption({ label: MFA_CHECKER.name });
  await policy.getByLabel('Reason').fill('E2E: Heads use a second factor');
  await policy.getByRole('button', { name: 'Submit MFA policy for approval' }).click();
  await expect(page.getByText(`Sent for approval to ${MFA_CHECKER.name}`)).toBeVisible();
  await approveSettingsAs(MFA_CHECKER);
  await logout(page);

  // Password alone lands on forced enrolment; nothing else is reachable.
  await page.goto('/login');
  await page.getByLabel('Work email').fill(ACCOUNTS.lead.email);
  await page.getByLabel('Password', { exact: true }).fill(ACCOUNTS.lead.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/mfa-setup');
  await page.goto('/team');
  await page.waitForURL('**/mfa-setup');
  const secret = await enrolAuthenticator(page, ACCOUNTS.lead.password);
  await page.getByRole('link', { name: /continue/ }).click();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await logout(page);

  await page.getByLabel('Work email').fill(ACCOUNTS.lead.email);
  await page.getByLabel('Password', { exact: true }).fill(ACCOUNTS.lead.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'That code is not valid' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(totp(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.goto('/account/security');
  await expect(page.getByRole('region', { name: 'Two-factor authentication' })).toContainText('on');
  await expect(page.getByRole('region', { name: 'Active sessions' })).toContainText('password + code');
  await logout(page);

  // Other specs sign leads in with a password only: lift the requirement again.
  await login(page, ACCOUNTS.admin);
  await page.goto('/settings');
  const lift = page.getByRole('form', { name: 'Require MFA for roles' });
  await lift.getByLabel('Head', { exact: true }).uncheck();
  await lift.getByLabel('Checker').selectOption({ label: MFA_CHECKER.name });
  await lift.getByLabel('Reason').fill('E2E: back to passwords');
  await lift.getByRole('button', { name: 'Submit MFA policy for approval' }).click();
  await expect(page.getByText(`Sent for approval to ${MFA_CHECKER.name}`)).toBeVisible();
  await approveSettingsAs(MFA_CHECKER);
});

test('a Service member who forgot their password resets it from the emailed link', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await page.getByLabel('Work email').fill(ACCOUNTS.exec.email);
  await page.getByRole('button', { name: 'Email me a reset link' }).click();
  await expect(page.getByText('Check your email.')).toBeVisible();

  // The e2e API uses the log email driver; a test-only hook (refused in production) exposes the message.
  const admin = await request.post(`${apiUrl}/v1/auth/login`, { data: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password } });
  const token = ((await admin.json()) as { token: string }).token;
  const mail = await request.get(`${apiUrl}/v1/test-hooks/emails?to=${encodeURIComponent(ACCOUNTS.exec.email)}`, { headers: { authorization: `Bearer ${token}` } });
  const messages = (await mail.json()) as Array<{ kind: string | null; text: string }>;
  const link = /https?:\/\/\S+\/reset-password\?token=[\w-]+/.exec(messages.filter((m) => m.kind === 'password_reset').at(-1)?.text ?? '')?.[0];
  expect(link).toBeTruthy();

  const newPassword = `${ACCOUNTS.exec.password}-renewed`;
  await acceptInvite(page, link!, newPassword, 'Set new password');
  await page.goto('/login');
  await page.getByLabel('Work email').fill(ACCOUNTS.exec.email);
  await page.getByLabel('Password', { exact: true }).fill(ACCOUNTS.exec.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid email or password' })).toBeVisible();
  await login(page, { ...ACCOUNTS.exec, password: newPassword });
});
