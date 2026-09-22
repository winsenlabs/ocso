'use client';

import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';
import { ssoClient } from '@better-auth/sso/client';

/**
 * Better Auth's browser client (ADR-025), used only where the browser itself
 * must take part: WebAuthn ceremonies (passkeys) and SSO redirects. It talks
 * to /api/auth on OCSO's own origin (proxy.ts forwards it to the API). Every
 * other auth step goes through server actions.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [passkeyClient(), ssoClient()],
});
