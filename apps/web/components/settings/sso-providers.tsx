'use client';

import { useState } from 'react';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { LifecycleActions } from '@/components/connections/lifecycle-actions';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { setAutoProvisionAction } from '@/lib/actions/auth-settings';
import type { SsoProvider } from '@/lib/api/auth-settings';
import { SsoProviderModal } from './sso-provider-modal';

/** Configured identity providers with what the IdP side needs (callback / ACS URL, SP metadata). */
export function SsoProviders({ providers }: { providers: SsoProvider[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="ch" aria-label="SSO providers" style={{ display: 'grid', gap: 12 }}>
      {providers.length ? (
        providers.map((p) => (
          <div className="sec-row" key={p.providerId} style={{ alignItems: 'flex-start' }}>
            <div className="sec-main">
              <b>
                {p.name} <StatusChip tone="accent">{p.type.toUpperCase()}</StatusChip>{' '}
                <StatusChip tone={p.status === 'ACTIVE' ? 'good' : 'muted'}>{p.status === 'DRAFT' ? 'draft · sign-in refused' : p.status.toLowerCase()}</StatusChip>{' '}
                {p.autoProvision ? <StatusChip tone="warn">auto-provisions Service members</StatusChip> : null}
              </b>
              <span className="mono-sm">domains: {p.domains.join(', ')}</span>
              <span className="mono-sm">{p.type === 'oidc' ? 'redirect URI' : 'ACS URL'}: {p.callbackUrl}</span>
              {p.saml ? <span className="mono-sm">SP metadata: {p.saml.spMetadataUrl}</span> : null}
              {p.oidc ? <span className="mono-sm">client: {p.oidc.clientId} · issuer {p.issuer}</span> : null}
            </div>
            <span className="sec-actions">
              {/* A draft changes directly; an approved provider's change is a proposal (the modal asks for a checker). */}
              <ApprovableButton
                label={p.autoProvision ? 'Invited users only' : 'Auto-provision'}
                title={p.autoProvision ? `Only invited users sign in with ${p.name}` : `Auto-provision users of ${p.name}`}
                confirmLabel="Change"
                target={{ objectKind: 'sso_provider', objectId: p.id, title: `Change SSO provider ${p.name}` }}
                write={(choice) => setAutoProvisionAction(p.providerId, !p.autoProvision, choice)}
              >
                {p.autoProvision ? 'Unknown users are refused; only invited users can sign in.' : 'Unknown users of these domains are created as Service members, pending approval.'}
              </ApprovableButton>
              <LifecycleActions kind="sso_provider" id={p.id} pathRef={p.providerId} name={p.name} state={p.status === 'ACTIVE' ? 'live' : p.status === 'DISABLED' ? 'stopped' : 'draft'} approval={p.approval} />
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
