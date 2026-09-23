'use client';

import { useState, useTransition } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { deleteSsoProviderAction, setAutoProvisionAction } from '@/lib/actions/auth-settings';
import type { SsoProvider } from '@/lib/api/auth-settings';
import { SsoProviderModal } from './sso-provider-modal';

/** Configured identity providers with what the IdP side needs (callback / ACS URL, SP metadata). */
export function SsoProviders({ providers }: { providers: SsoProvider[] }) {
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => setMessage((await fn()).message));
  return (
    <section className="ch" aria-label="SSO providers" style={{ display: 'grid', gap: 12 }}>
      {message ? (
        <span className="mono-sm" role="status">
          {message}
        </span>
      ) : null}
      {providers.length ? (
        providers.map((p) => (
          <div className="sec-row" key={p.providerId} style={{ alignItems: 'flex-start' }}>
            <div className="sec-main">
              <b>
                {p.name} <StatusChip tone="accent">{p.type.toUpperCase()}</StatusChip> {p.autoProvision ? <StatusChip tone="warn">auto-provisions Service members</StatusChip> : null}
              </b>
              <span className="mono-sm">domains: {p.domains.join(', ')}</span>
              <span className="mono-sm">{p.type === 'oidc' ? 'redirect URI' : 'ACS URL'}: {p.callbackUrl}</span>
              {p.saml ? <span className="mono-sm">SP metadata: {p.saml.spMetadataUrl}</span> : null}
              {p.oidc ? <span className="mono-sm">client: {p.oidc.clientId} · issuer {p.issuer}</span> : null}
            </div>
            <span className="sec-actions">
              <button type="button" className="btn tiny" disabled={pending} onClick={() => run(() => setAutoProvisionAction(p.providerId, !p.autoProvision))}>
                {p.autoProvision ? 'Invited users only' : 'Auto-provision'}
              </button>
              <button
                type="button"
                className="btn tiny danger"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Remove ${p.name}? Users who only sign in with it will need a password reset link.`)) run(() => deleteSsoProviderAction(p.providerId));
                }}
              >
                Remove
              </button>
            </span>
          </div>
        ))
      ) : (
        <EmptyState size="sm" title="No SSO providers">
          Users sign in with a password (and passkeys). Add Okta, Microsoft Entra ID, Google Workspace or any OIDC / SAML 2.0 provider.
        </EmptyState>
      )}
      <button type="button" className="btn" onClick={() => setAdding(true)} style={{ justifySelf: 'start' }}>
        Add SSO provider
      </button>
      {adding ? <SsoProviderModal onClose={() => setAdding(false)} /> : null}
    </section>
  );
}
