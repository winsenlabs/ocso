import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, settled } from './helpers';

/**
 * System control center, alerts, audit and the role homes (design/03, design/06,
 * docs/10–11, docs/archive/specs/15) against the real API and worker, on a fresh database:
 *   E2E_API_PORT=4470 E2E_WEB_PORT=3470 E2E_DB_NAME=ocso_e2e_sys npx playwright test e2e/system.spec.ts
 * (add E2E_WEB_DEV=1 when other agents share the .next build output).
 */
test.describe.configure({ mode: 'serial' });

const USERS = {
  lead: { name: 'Sana Lead', email: 'sana.lead@e2e.ocso.test', password: 'correct-horse-battery-slead', role: 'HEAD' },
  exec: { name: 'Omar Exec', email: 'omar.exec@e2e.ocso.test', password: 'correct-horse-battery-sexec', role: 'SERVICE' },
} as const;

async function call(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test.beforeAll(async () => {
  const status = (await (await call('GET', '/v1/setup/status')).json()) as { setupRequired: boolean };
  if (status.setupRequired) {
    const res = await call('POST', '/v1/setup', {
      setupToken: E2E.setupToken,
      orgName: 'E2E Bank',
      adminName: ACCOUNTS.admin.name,
      adminEmail: ACCOUNTS.admin.email,
      adminPassword: ACCOUNTS.admin.password,
    });
    expect(res.status).toBe(201);
  }
  const login = await call('POST', '/v1/auth/login', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password });
  const { token } = (await login.json()) as { token: string };
  for (const u of Object.values(USERS)) {
    const res = await call('POST', '/v1/users', { name: u.name, email: u.email, role: u.role, password: u.password }, token);
    expect([201, 409]).toContain(res.status);
  }
});

const field = (page: Page, label: string) => page.getByRole('form', { name: 'Edit worker configuration' }).getByLabel(label, { exact: false });

/** Settings are always live: every change names a checker (Sana, a Head) and a reason (PM/research/11 §4). */
async function nameChecker(page: Page, form: string, reason = 'E2E: settings change'): Promise<void> {
  const f = page.getByRole('form', { name: form });
  await f.getByLabel('Checker').selectOption({ label: USERS.lead.name });
  await f.getByLabel('Reason').fill(reason);
}

/** Sana approves the open proposal of this kind (the approvals screen has its own spec). */
async function approveAsLead(objectKind: string): Promise<void> {
  const { token } = (await (await call('POST', '/v1/auth/login', { email: USERS.lead.email, password: USERS.lead.password })).json()) as { token: string };
  const rows = ((await (await call('GET', `/v1/approvals?box=AWAITING_ME&objectKind=${objectKind}`, undefined, token)).json()) as { rows: Array<{ id: string; contentHash: string }> }).rows;
  expect(rows.length, `an open ${objectKind} proposal for ${USERS.lead.name}`).toBeGreaterThan(0);
  const res = await call('POST', `/v1/approvals/${rows[0]!.id}/decision`, { decision: 'APPROVE', reason: 'E2E: reviewed', contentHash: rows[0]!.contentHash }, token);
  expect(res.status).toBe(200);
}

test('Tech admin sees the control center built from real (empty) telemetry', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/system');
  await settled(page);
  await expect(page.getByRole('heading', { name: 'System control center' })).toBeVisible();
  const status = page.getByRole('region', { name: 'Service status' });
  await expect(status.getByRole('list', { name: 'Services' })).toContainText('PostgreSQL');
  await expect(status).toContainText('uptime 30d');
  await expect(page.locator('.tile').filter({ hasText: 'active conversations' })).toContainText('0');
  await expect(page.getByRole('heading', { name: 'Worker instances' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Worker configuration' })).toContainText('max workers');
  await expect(page.getByText('No model provider configured')).toBeVisible();
  await expect(page.getByText('No MCP connection yet')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Token usage and cache · today' })).toContainText('cache read');

  await page.goto('/system/queues');
  await settled(page);
  await expect(page.getByRole('table', { name: 'Queue topics' })).toContainText('conversation.turn');

  await page.goto('/system/telemetry?minutes=180');
  await settled(page);
  await expect(page.getByRole('link', { name: 'Last 3h' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: 'Usage by provider' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Latency percentiles' })).toContainText('Time to first token');
  await expect(page.locator('.tile').filter({ hasText: 'turn latency p50 · p95 · 3h' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Usage by request purpose · today' })).toBeVisible();
  await expect(page.getByText('not reported by the telemetry API yet')).toHaveCount(0);
});

test('Tech admin changes a worker setting; it persists, and an invalid value shows the API error inline', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/system/workers');
  await settled(page);
  await expect(page.getByRole('region', { name: 'Scaling apply status' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Worker deployment' })).toBeVisible();

  // Settings change by approval: the change is proposed, Sana approves it, then it applies.
  await field(page, 'Max workers').fill('12');
  await nameChecker(page, 'Edit worker configuration', 'E2E: more headroom');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByRole('form', { name: 'Edit worker configuration' }).getByRole('status')).toContainText(`Sent for approval to ${USERS.lead.name}`);
  await page.reload();
  await settled(page);
  await expect(field(page, 'Max workers')).toHaveValue('10');
  await approveAsLead('deployment_settings');
  await page.reload();
  await settled(page);
  await expect(field(page, 'Max workers')).toHaveValue('12');

  await field(page, 'Min warm workers').fill('50');
  await nameChecker(page, 'Edit worker configuration');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.locator('#wk-minWarmWorkers-error')).toContainText('must not exceed max workers');
  await expect(field(page, 'Min warm workers')).toHaveAttribute('aria-invalid', 'true');

  await field(page, 'Min warm workers').fill('2');
  await field(page, 'Max workers').fill('0');
  await nameChecker(page, 'Edit worker configuration');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.locator('#wk-maxWorkers-error')).toContainText('expected number to be >=1');
  await page.reload();
  await settled(page);
  await expect(field(page, 'Max workers')).toHaveValue('12');
});

test('Tech admin adds an in-app destination, sees the seeded rules and creates a technical rule', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/alerts?tab=destinations');
  await settled(page);
  await page.getByRole('link', { name: 'Add destination' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add notification destination' });
  await dialog.getByLabel('Destination name').fill('E2E ops inbox');
  await dialog.getByLabel('Type').selectOption('IN_APP');
  await dialog.getByRole('button', { name: 'Add destination' }).click();
  await expect(dialog).toBeHidden();
  const destinations = page.getByRole('table', { name: 'Notification destinations' });
  await expect(destinations).toContainText('E2E ops inbox');
  // A new destination is a disabled draft; enabling it is a second person's approval.
  const inbox = destinations.getByRole('row', { name: /E2E ops inbox/ });
  await expect(inbox).toContainText('draft');
  await inbox.getByRole('button', { name: 'Enable E2E ops inbox' }).click();
  const modal = page.getByRole('dialog', { name: 'Submit for approval' });
  await modal.getByLabel('checker').selectOption({ label: USERS.lead.name });
  await modal.getByLabel('reason').fill('E2E: ops inbox');
  await modal.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(inbox).toContainText(`Pending approval · awaiting ${USERS.lead.name}`);
  await approveAsLead('notification_destination');
  await page.reload();
  await settled(page);
  await expect(destinations.getByRole('row', { name: /E2E ops inbox/ })).toContainText('enabled');
  await expect(destinations).toContainText('In-app notifications'); // seeded by setup
  await destinations.getByRole('button', { name: 'Send a test alert to E2E ops inbox' }).click();
  await expect(destinations.getByRole('status').filter({ hasText: 'test' })).toContainText('test delivered');

  await page.goto('/alerts?tab=rules');
  await settled(page);
  const technical = page.getByRole('table', { name: 'Technical alert rules' });
  for (const seeded of ['Healthy workers below minimum', 'Conversation queue age above 30s', 'Provider error rate above 5%', 'Database degraded']) {
    await expect(technical).toContainText(seeded);
  }
  await expect(page.getByRole('table', { name: 'Business alert rules' })).toHaveCount(0);

  await page.getByRole('link', { name: 'New technical rule' }).click();
  const rule = page.getByRole('dialog', { name: 'New technical rule' });
  await rule.getByLabel('Rule name', { exact: true }).fill('E2E token spike');
  await rule.getByLabel('Condition', { exact: true }).selectOption({ label: 'Token usage spike' });
  await expect(rule.getByLabel('Ratio', { exact: true })).toHaveValue('3');
  await rule.getByLabel('Severity', { exact: true }).selectOption('CRITICAL');
  await rule.getByRole('checkbox', { name: 'E2E ops inbox' }).check();
  await rule.getByRole('button', { name: 'Create rule' }).click();
  await expect(rule).toBeHidden();
  await expect(technical).toContainText('E2E token spike');
  await expect(technical).toContainText('E2E ops inbox');
  await page.goto('/');
  await settled(page);
  await expect(page.locator('.greeting h1')).toContainText('Tara,');
  await expect(page.getByRole('region', { name: 'Recent privileged changes' })).toContainText('E2E token spike');
  // Tech Home: needs you, the health strip, incidents, capacity and the service flow.
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Platform health' }).getByRole('link', { name: /workers/ })).toHaveAttribute('href', '/system/workers');
  await expect(page.getByRole('heading', { name: 'Open incidents and alerts' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Service flow' })).toBeVisible();
});

test('Tech admin opens a real technical alert, sees its deliveries, acknowledges and resolves it', async ({ page }) => {
  test.setTimeout(150_000);
  await login(page, ACCOUNTS.admin);
  // One e2e worker against min warm workers 2: the seeded rule fires on the worker's next evaluation.
  const row = page.getByRole('table', { name: 'Alerts' }).getByRole('link', { name: /Healthy workers below minimum/ });
  await expect(async () => {
    await page.goto('/alerts');
    await settled(page);
    await expect(row).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000] });

  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Healthy workers below minimum' });
  await expect(drawer).toContainText('audienceTech'); // presets were renamed Tech/Head/Lead/Service (PM/research/11 §3)
  await expect(drawer.getByRole('table', { name: 'Deliveries' })).toContainText('In-app notifications');
  await drawer.getByLabel(/note/).fill('Only one e2e worker is running.');
  await drawer.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(drawer.locator('.schip', { hasText: /^acked$/ })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  await expect(drawer).toContainText('Tara Admin (you)');

  await drawer.getByLabel(/note/).fill('Accepted for the e2e stack.');
  await drawer.getByRole('button', { name: 'Resolve' }).click();
  await expect(drawer.locator('.schip', { hasText: /^resolved$/ })).toBeVisible();
  await expect(drawer).toContainText('Accepted for the e2e stack.');
  await expect(drawer.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
});

test('the audit log shows those changes with a before/after view', async ({ page }) => {
  await login(page, ACCOUNTS.admin);
  await page.goto('/audit');
  await settled(page);
  const entries = page.getByRole('table', { name: 'Audit entries' });
  await expect(entries).toContainText('Worker configuration: maxWorkers 10 → 12');
  await expect(entries).toContainText('Created technical alert rule "E2E token spike"');
  await expect(entries).toContainText('Created In-app destination "E2E ops inbox"');
  await expect(entries).toContainText('Acknowledged alert: Healthy workers below minimum');
  await expect(entries).toContainText('Resolved alert: Healthy workers below minimum');

  await page.getByLabel('Target type').selectOption('worker_settings');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/targetType=worker_settings/);
  await settled(page);
  await expect(entries).not.toContainText('E2E token spike');
  await entries.getByRole('link', { name: /maxWorkers 10 → 12/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Worker configuration: maxWorkers 10 → 12' });
  const diff = drawer.getByRole('table', { name: 'Before and after' });
  await expect(diff.getByRole('row', { name: 'maxWorkers changed' })).toContainText('10');
  await expect(diff.getByRole('row', { name: 'maxWorkers changed' })).toContainText('12');
});

test('Lead sees only business alerts and rules, and the lead home', async ({ page }) => {
  await login(page, USERS.lead);
  await settled(page);
  await expect(page.locator('.greeting h1')).toContainText('Sana,');
  // Head Home: needs you first, then the live service flow (empty deployment) and agent quality.
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Service flow' })).toContainText('No channel, router or queue yet');
  await expect(page.getByRole('heading', { name: 'Agent quality' })).toBeVisible();
  // Nothing is live yet (no channel): the setup checklist stands in for tiles with no data.
  const setup = page.getByRole('region', { name: 'Set up OCSO' });
  await expect(setup).toBeVisible();
  await expect(page.getByRole('list', { name: /Key numbers/ })).toHaveCount(0);
  // Steps a Lead cannot do are not links: choosing the Ask OCSO model is Tech's.
  await expect(setup.getByRole('link', { name: /Ask OCSO runs on/ })).toHaveCount(0);
  await expect(setup.getByRole('link', { name: /Open a channel/ })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Platform health' })).toHaveCount(0);
  await expect(page.getByText('uptime 30d')).toHaveCount(0);

  await page.goto('/alerts');
  await settled(page);
  await expect(page.getByRole('group', { name: 'Kind' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Destinations' })).toHaveCount(0);
  const rows = page.getByRole('table', { name: 'Alerts' });
  if (await rows.count()) await expect(rows).not.toContainText('technical');

  await page.goto('/alerts?tab=rules');
  await settled(page);
  const business = page.getByRole('table', { name: 'Business alert rules' });
  await expect(business).toContainText('Escalation rate above 25%');
  await expect(business).toContainText('SLA breaches');
  await expect(page.getByRole('table', { name: 'Technical alert rules' })).toHaveCount(0);
  await expect(page.getByText('E2E token spike')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New business rule' })).toBeVisible();
});

test('Service member sees the exec home', async ({ page }) => {
  await login(page, USERS.exec);
  await settled(page);
  await expect(page.locator('.greeting h1')).toContainText('Omar,');
  await expect(page.locator('.greeting h1')).toContainText('nobody is waiting on a human.');
  await expect(page.locator('.greeting-strip')).toContainText('0 assigned');
  await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
  // Small stats with trends, each linking to where the number comes from.
  const numbers = page.getByRole('list', { name: /Key numbers/ });
  await expect(numbers.getByRole('link', { name: /Resolved today/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My queue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take next conversation' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'My shift' }).getByRole('group', { name: 'Availability' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Service flow' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Set up OCSO' })).toHaveCount(0);
  await expect(page.getByText('open incidents')).toHaveCount(0);
});
