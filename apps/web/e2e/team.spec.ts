import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ACCOUNTS, E2E, apiUrl } from './config';
import { login, logout } from './helpers';

/**
 * Team membership (ADR-026) through the Team page against the real API: a CS
 * Lead creates a team (and is its first member), adds a Service member from the team
 * drawer but is never offered another lead; the exec then works in that team;
 * the Tech admin moves the lead to another team from the People table (the
 * confirmation names the agent they lose) and the lead's agent list follows;
 * a lead leaving their last agent-owning team is warned first.
 */
test.describe.configure({ mode: 'serial' });

const LEAD = { name: 'Nina Lead', email: 'tm.lead@e2e.ocso.test', password: 'correct-horse-battery-tmlead' };
const LEAD2 = { name: 'Owen Lead', email: 'tm.lead2@e2e.ocso.test', password: 'correct-horse-battery-tmlead2' };
const EXEC = { name: 'Pia Exec', email: 'tm.exec@e2e.ocso.test', password: 'correct-horse-battery-tmexec' };
const CARDS = 'TM Cards';
const LOANS = 'TM Loans';

let api: APIRequestContext;
const tok = { admin: '', lead: '', lead2: '' };
const ids = { loans: '' };

async function call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
  const res = await api.fetch(path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { data: body } : {}) });
  if (![200, 201, 204].includes(res.status())) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  return (res.status() === 204 ? {} : await res.json()) as T;
}
const loginApi = async (email: string, password: string) => (await call<{ token: string }>('POST', '/v1/auth/login', null, { email, password })).token;
const user = (who: { name: string; email: string; password: string }, role: string) => ({ name: who.name, email: who.email, role, password: who.password, teamIds: [], languages: [], maxConcurrent: 5 });

const agentsTable = (page: Page) => page.getByRole('table', { name: 'Virtual agents' });
const openTeam = async (page: Page, name: string) => {
  await page.getByRole('table', { name: 'Teams' }).getByRole('link', { name, exact: true }).click();
  const drawer = page.getByRole('dialog', { name, exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
};

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: apiUrl });
  const status = await call<{ setupRequired: boolean }>('GET', '/v1/setup/status', null);
  if (status.setupRequired) {
    await call('POST', '/v1/setup', null, { setupToken: E2E.setupToken, orgName: 'E2E Bank', adminName: ACCOUNTS.admin.name, adminEmail: ACCOUNTS.admin.email, adminPassword: ACCOUNTS.admin.password, timezone: 'Asia/Kolkata' });
  }
  tok.admin = await loginApi(ACCOUNTS.admin.email, ACCOUNTS.admin.password);
  await call('POST', '/v1/users', tok.admin, user(LEAD, 'HEAD'));
  await call('POST', '/v1/users', tok.admin, user(LEAD2, 'HEAD'));
  await call('POST', '/v1/users', tok.admin, user(EXEC, 'SERVICE'));
  tok.lead = await loginApi(LEAD.email, LEAD.password);
  tok.lead2 = await loginApi(LEAD2.email, LEAD2.password);
  // Owen's team and its agent: Nina cannot see either agent of the other team.
  ids.loans = (await call<{ id: string }>('POST', '/v1/teams', tok.lead2, { name: LOANS })).id;
  await call('POST', '/v1/agents', tok.lead2, { name: 'Nova', slug: 'nova-tm', purpose: 'loan servicing', conversationType: 'SUPPORT', teamIds: [ids.loans] });
});

test.afterAll(async () => {
  await api?.dispose();
});

test('a Lead creates a team, is its first member, and adds a Service member (never another lead)', async ({ page }) => {
  await login(page, LEAD);
  await page.goto('/team');
  await page.getByRole('button', { name: 'New team' }).click();
  await page.getByLabel('Team name').fill(CARDS);
  await page.getByRole('button', { name: 'Create team' }).click();
  await expect(page.getByRole('table', { name: 'Teams' }).getByText('your team')).toBeVisible();

  const drawer = await openTeam(page, CARDS);
  const members = drawer.getByRole('list', { name: 'Members' });
  await expect(members.getByRole('listitem')).toHaveCount(1);
  await expect(members).toContainText(LEAD.name);
  await expect(members).toContainText('Lead');
  await expect(members).toContainText('added ');

  // Only Service members are offered: no lead, no admin.
  const search = drawer.getByLabel('Add member');
  const picker = drawer.getByRole('list', { name: 'People you can add' });
  await expect(drawer.getByText('Leads add Service members. A Tech admin adds other leads.')).toBeVisible();
  for (const other of ['owen', 'tara.admin']) {
    await search.fill(other);
    await expect(drawer.getByText('Nobody matches that search.')).toBeVisible();
  }
  await search.fill('pia');
  await expect(picker.getByRole('listitem')).toHaveCount(1);
  await picker.getByRole('button', { name: `Add ${EXEC.name}` }).click();
  await expect(drawer.getByText(`Added ${EXEC.name} to ${CARDS}`)).toBeVisible();
  await expect(members.getByRole('listitem')).toHaveCount(2);
  await expect(members).toContainText(EXEC.name);

  await drawer.getByRole('button', { name: 'Rename or describe' }).click();
  await drawer.getByLabel('Description').fill('Card disputes and EMI');
  await drawer.getByRole('button', { name: 'Save team' }).click();
  await expect(drawer.getByText('Card disputes and EMI')).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(drawer).toBeHidden();

  // People table: the lead edits Service member teams (and their own), never another lead's.
  const people = page.getByRole('table', { name: 'People' });
  await expect(people.getByRole('button', { name: `Edit teams of ${EXEC.name}` })).toBeVisible();
  await expect(people.getByRole('button', { name: `Edit teams of ${LEAD2.name}` })).toHaveCount(0);
  await expect(people.getByRole('row').filter({ hasText: EXEC.email }).getByRole('link', { name: CARDS })).toBeVisible();

  // Another lead's team: visible, but its memberships are not Nina's to change.
  const loans = await openTeam(page, LOANS);
  await expect(loans.getByText('Only members of this team change its memberships.')).toBeVisible();
  await expect(loans.getByLabel('Add member')).toHaveCount(0);
  await expect(loans.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await logout(page);
});

test('the Service member now works in the team', async ({ page }) => {
  await login(page, EXEC);
  await expect(page.locator('.scope-sw')).toContainText(CARDS);
});

test('the Tech admin moves the lead to another team and the lead’s agents follow', async ({ page }) => {
  const teams = await call<Array<{ id: string; name: string }>>('GET', '/v1/teams', tok.lead);
  const cards = teams.find((t) => t.name === CARDS)!.id;
  await call('POST', '/v1/agents', tok.lead, { name: 'Pixel', slug: 'pixel-tm', purpose: 'card disputes', conversationType: 'SUPPORT', teamIds: [cards] });

  await login(page, LEAD);
  await page.goto('/agents');
  await expect(agentsTable(page).getByText('Pixel')).toBeVisible();
  await expect(agentsTable(page).getByText('Nova')).toHaveCount(0);
  await logout(page);

  await login(page, ACCOUNTS.admin);
  await page.goto('/team');
  await page.getByRole('button', { name: `Edit teams of ${LEAD.name}` }).click();
  const edit = page.getByRole('dialog', { name: `Teams · ${LEAD.name}` });
  await edit.getByRole('checkbox', { name: CARDS, exact: true }).uncheck();
  await edit.getByRole('checkbox', { name: LOANS, exact: true }).check();
  await edit.getByRole('button', { name: 'Save teams' }).click();
  const confirm = page.getByRole('dialog', { name: 'Change teams' });
  await expect(confirm).toContainText(`${LEAD.name} will no longer manage Pixel: no other team of theirs owns it.`);
  await expect(confirm).toContainText(`${CARDS} will have no Lead left to manage its agents.`);
  await confirm.getByRole('button', { name: 'Save teams' }).click();
  await expect(confirm).toBeHidden();
  const row = page.getByRole('table', { name: 'People' }).getByRole('row').filter({ hasText: LEAD.email });
  await expect(row.getByRole('link', { name: LOANS })).toBeVisible();
  await expect(row.getByRole('link', { name: CARDS })).toHaveCount(0);

  const loans = await openTeam(page, LOANS);
  await expect(loans.getByRole('list', { name: 'Members' })).toContainText(LEAD.name);
  await expect(loans.getByRole('region', { name: 'Owning agents' })).toContainText('Nova');
  await logout(page);

  await login(page, LEAD);
  await page.goto('/agents');
  await expect(agentsTable(page).getByText('Nova')).toBeVisible();
  await expect(agentsTable(page).getByText('Pixel')).toHaveCount(0);
});

test('a lead leaving their last agent-owning team is told what they lose first', async ({ page }) => {
  await login(page, LEAD);
  await page.goto(`/team?team=${ids.loans}`);
  const drawer = page.getByRole('dialog', { name: LOANS, exact: true });
  await drawer.getByRole('button', { name: `Leave ${LOANS}` }).click();
  const confirm = page.getByRole('dialog', { name: `Leave ${LOANS}` });
  await expect(confirm).toContainText('Access will be lost');
  await expect(confirm).toContainText('You will lose access to Nova: none of your remaining teams owns it.');
  await expect(confirm).toContainText('Only a Tech admin can add you back.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(drawer.getByRole('list', { name: 'Members' })).toContainText(LEAD.name);
});
