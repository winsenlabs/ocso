'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { authClient } from '@/lib/auth-client';

/**
 * Browser-driven sign-in (ADR-025): a passkey (WebAuthn needs the browser),
 * and SSO when a provider is configured (the IdP redirect happens here; the
 * provider is chosen from the email's domain).
 */
export function AlternativeSignIn({ next, sso }: { next: string; sso: boolean }) {
  const [busy, setBusy] = useState<'passkey' | 'sso' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passkey = async () => {
    setBusy('passkey');
    setError(null);
    const result = await authClient.signIn.passkey();
    if (result.error) {
      setBusy(null);
      setError(result.error.message ?? 'Passkey sign-in was cancelled or failed.');
      return;
    }
    window.location.assign(next);
  };

  const singleSignOn = async () => {
    const email = (document.getElementById('email') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!email.includes('@')) {
      setError('Enter your work email first: it selects your organization’s sign-in.');
      return;
    }
    setBusy('sso');
    setError(null);
    const result = await authClient.signIn.sso({ email, callbackURL: next, errorCallbackURL: '/login?sso=failed' });
    if (result.error) {
      setBusy(null);
      setError(result.error.status === 404 ? 'Single sign-on is not set up for this email domain.' : (result.error.message ?? 'Single sign-on failed.'));
    }
  };

  return (
    <div className="auth-alt">
      <div className="auth-divider">or</div>
      {error ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {error}
        </AlertBanner>
      ) : null}
      <button type="button" className="btn wide" onClick={() => void passkey()} disabled={busy !== null}>
        {busy === 'passkey' ? 'Waiting for your passkey…' : 'Use a passkey'}
      </button>
      {sso ? (
        <button type="button" className="btn wide" onClick={() => void singleSignOn()} disabled={busy !== null}>
          {busy === 'sso' ? 'Redirecting…' : 'Continue with single sign-on'}
        </button>
      ) : null}
    </div>
  );
}
