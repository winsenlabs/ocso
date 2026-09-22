import { expect, test } from '@playwright/test';

/** proxy.ts optimistic redirects and the ADR-020 public ingress rewrites. */

test('app routes without a session cookie redirect to /login with the return path', async ({ request }) => {
  const res = await request.get('/connections?tab=mcp', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['location']).toMatch(/\/login\?next=%2Fconnections%3Ftab%3Dmcp$/);

  const home = await request.get('/', { maxRedirects: 0 });
  expect(home.status()).toBe(307);
  expect(home.headers()['location']).toMatch(/\/login$/);
});

test('app API routes answer 401 JSON instead of redirecting', async ({ request }) => {
  const res = await request.post('/api/internal-agent', { data: { message: 'hi' }, maxRedirects: 0 });
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe('unauthenticated');
});

test('sign-in and setup pages are reachable without a session', async ({ request }) => {
  for (const path of ['/login', '/setup']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
  }
});

test('an invalid session cookie is rejected by the API and lands on sign-in', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'ocso_session', value: 'x'.repeat(40), url: baseURL ?? '' }]);
  await page.goto('/team');
  // /login (or /setup, if this file runs before the setup story) — never the app.
  await page.waitForURL((url) => url.pathname === '/login' || url.pathname === '/setup');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
});

test('public ingress paths are forwarded to the API, not rendered by Next', async ({ request }) => {
  for (const path of ['/channels/e2e-probe', '/public/e2e-probe', '/oauth/e2e-probe', '/.well-known/e2e-probe', '/blobs/e2e-probe']) {
    const res = await request.get(path, { maxRedirects: 0 });
    // Whatever the API answers, it is its JSON error envelope — never a login redirect or a Next page.
    expect(res.status(), path).not.toBe(307);
    expect(res.headers()['content-type'] ?? '', path).toContain('application/json');
    expect((await res.json()).error, path).toBeTruthy();
  }
});
