import { expect, type Page } from '@playwright/test';

export interface Account {
  name: string;
  email: string;
  password: string;
}

export async function login(page: Page, account: Account, landing = '/'): Promise<void> {
  if (!page.url().includes('/login')) await page.goto('/login');
  await page.getByLabel('Work email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname === landing);
  await expect(primaryNav(page)).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.pathname === '/login');
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

export async function createUser(page: Page, user: Account & { role?: string; team?: string }): Promise<void> {
  await page.getByRole('button', { name: 'New user' }).click();
  const dialog = page.getByRole('dialog', { name: 'New user' });
  await dialog.getByLabel('Full name').fill(user.name);
  await dialog.getByLabel('Work email').fill(user.email);
  if (user.role) await dialog.getByLabel('Role').selectOption(user.role);
  await dialog.getByLabel('Initial password').fill(user.password);
  if (user.team) await dialog.getByLabel(user.team).check();
  await dialog.getByRole('button', { name: 'Create user' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('table', { name: 'People' }).getByText(user.email)).toBeVisible();
}
