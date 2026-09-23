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
  for (const path of ['/login', '/setup', '/forgot-password', '/reset-password', '/invite', '/recover']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
  }
});

test('an invalid session cookie is rejected by the API and lands on sign-in', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'ocso.session_token', value: `${'x'.repeat(32)}.forged-signature`, url: baseURL ?? '' }]);
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

test('/api/auth is Better Auth on the API, reachable without a session and closed beyond its allowlist', async ({ request }) => {
  const session = await request.get('/api/auth/get-session', { maxRedirects: 0 });
  expect(session.status()).toBe(200);
  expect(await session.json()).toBeNull();
  // Sign-up and user self-updates are not part of OCSO (ADR-025): 404 from the API, not a Next page or redirect.
  const signUp = await request.post('/api/auth/sign-up/email', { data: { email: 'x@e2e.test', password: 'long enough password', name: 'X' }, maxRedirects: 0 });
  expect(signUp.status()).toBe(404);
  expect(signUp.headers()['content-type'] ?? '').toContain('application/json');
});
