import { expect, type Page } from '@playwright/test';

export interface Account {
  name: string;
  email: string;
  password: string;
}

export async function login(page: Page, account: Account, landing = '/'): Promise<void> {
  if (!page.url().includes('/login')) await page.goto('/login');
  await page.getByLabel('Work email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === landing);
  await expect(primaryNav(page)).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
  // The URL changes before the sign-in page replaces the previous one.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

export function primaryNav(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' });
}

/** Group labels and item names of the sidebar, in order. */
export async function navModel(page: Page): Promise<{ groups: string[]; items: string[] }> {
  const nav = primaryNav(page);
  await expect(nav).toBeVisible();
  return {
    groups: await nav.locator('.sb-group-label').allTextContents(),
    items: await nav.locator('.sb-name').allTextContents(),
  };
}

/** Visits every sidebar link and asserts none of them is a 404. */
export async function expectNavLinksResolve(page: Page): Promise<void> {
  const hrefs = await primaryNav(page).locator('a.sb-item').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of new Set(hrefs)) {
    const response = await page.goto(href);
    expect(response?.status(), `status of ${href}`).toBe(200);
    await expect(page.locator('.page-head h1, .greeting h1').first(), `heading on ${href}`).toBeVisible();
    await expect(page.getByText('Page not found')).toHaveCount(0);
  }
}

/** Waits until every streamed Suspense body on the page has resolved. */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

/**
 * Invite a user from Team & roles, then accept the invite as them (ADR-025).
 * The e2e API runs the log email driver, so the dialog shows the set-password
 * link once; the invitee opens it in a separate browser context.
 */
export async function createUser(page: Page, user: Account & { role?: string; team?: string }): Promise<void> {
  await page.getByRole('button', { name: 'New user' }).click();
  const dialog = page.getByRole('dialog', { name: 'New user' });
  await dialog.getByLabel('Full name').fill(user.name);
  await dialog.getByLabel('Work email').fill(user.email);
  if (user.role) await dialog.getByLabel('Role').selectOption(user.role);
  if (user.team) await dialog.getByLabel(user.team).check();
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  const link = await dialog.getByLabel(/Set-password link/).inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await acceptInvite(page, link, user.password);
  await expect(page.getByRole('table', { name: 'People' }).getByText(user.email)).toBeVisible();
}

/** Open an invite (or password-reset) link as the invitee and choose their password. */
export async function acceptInvite(page: Page, link: string, password: string, button = 'Set password and continue'): Promise<void> {
  const browser = page.context().browser();
  if (!browser) throw new Error('acceptInvite needs a browser-backed page');
  const invitee = await browser.newContext();
  try {
    const other = await invitee.newPage();
    await other.goto(link);
    await other.getByLabel('New password', { exact: true }).fill(password);
    await other.getByLabel('Confirm password').fill(password);
    await other.getByRole('button', { name: button }).click();
    await other.waitForURL((url) => url.pathname === '/login');
  } finally {
    await invitee.close();
  }
}
