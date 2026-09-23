'use client';

import { useState } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { beginOAuthAction, headerAuthAction } from '@/lib/actions/mcp';
import type { Connection, McpArea } from '@/lib/api/mcp';
import { Input } from '../../profiles/profile-fields';
import { authLabel, serverInfoSummary } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';

interface AuthPanelProps {
  connection: Connection;
  area: McpArea;
  api: Pick<StepApi, 'run' | 'fail' | 'notify' | 'pending'>;
  /** Called after a header credential led to a successful discovery. */
  onDiscovered: () => void;
}

/**
 * Authenticate a connection: the OAuth 2.1 redirect flow (the browser leaves
 * for the authorization server and returns to this page with an outcome), or
 * a static header credential. Either way OCSO stores only a secret reference.
 */
export function AuthPanel({ connection, area, api, onDiscovered }: AuthPanelProps) {
  const info = serverInfoSummary(connection.serverInfo);
  const required = info.authRequired;
  const oauthPossible = required?.oauthAvailable === true || connection.auth.strategy === 'OAUTH';
  const [headerName, setHeaderName] = useState(connection.auth.headerName ?? 'Authorization');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');

  function oauth() {
    api.run(async () => {
      const r = await beginOAuthAction(connection.id, area, { clientId: clientId.trim(), clientSecret, scopes });
      if (!r.ok) api.fail(r.message);
      else window.location.assign(r.data.authorizationUrl);
    });
  }

  function header() {
    if (!token.trim()) {
      api.fail('Enter the credential value (for bearer tokens, include the "Bearer " prefix).');
      return;
    }
    api.run(async () => {
      const r = await headerAuthAction(connection.id, area, headerName.trim(), token);
      setToken('');
      if (!r.ok) api.fail(r.message);
      else if (r.data.outcome !== 'DISCOVERED') api.fail(`The server still rejects the credential. ${r.data.message}`);
      else {
        api.notify(`Credential stored by reference. ${r.data.message}`);
        onDiscovered();
      }
    });
  }

  const authenticated = connection.auth.strategy !== 'NONE';
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <KeyValue
        items={[
          { k: 'current', v: authenticated ? `${authLabel(connection.auth)}${connection.auth.issuer ? ` · ${connection.auth.issuer}` : ''}` : 'no credential stored' },
          ...(connection.auth.scopes.length ? [{ k: 'scopes granted', v: connection.auth.scopes.join(' · ') }] : []),
          ...(required ? [{ k: 'server asks', v: `${required.reason.replace(/_/g, ' ')}${required.scopesSupported.length ? ` · scopes ${required.scopesSupported.join(' · ')}` : ''}` }] : []),
          ...(required?.authorizationServers.length ? [{ k: 'auth server', v: <span className="mono-sm">{required.authorizationServers.join(', ')}</span> }] : []),
          { k: 'secret', v: 'stored in the secret store; OCSO keeps only the reference' },
        ]}
      />
      {!required && !authenticated && connection.lastSyncAt ? (
        <EmptyState title="No authentication required" size="sm">
          The server answered discovery without credentials. You can still add a header credential if it expects one for tool calls.
        </EmptyState>
      ) : null}
      {oauthPossible ? (
        <div className="auth-box">
          <b style={{ fontSize: 12.5 }}>OAuth 2.1 · authorization code + PKCE</b>
          <span className="mono-sm">You leave OCSO for the authorization server and come back here with the outcome.</span>
          <details>
            <summary className="mono-sm">Pre-registered client (only if the server has no client registration)</summary>
            <div className="fld-row" style={{ marginTop: 8 }}>
              <Input id="oa-client" label="Client ID" value={clientId} onChange={setClientId} />
              <div className="fld">
                <label htmlFor="oa-secret">Client secret (optional)</label>
                <input id="oa-secret" type="password" autoComplete="new-password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
              </div>
            </div>
            <Input id="oa-scopes" label="Scopes (optional)" value={scopes} onChange={setScopes} hint="space-separated; default: what the server advertises" />
          </details>
          <div>
            <button type="button" className="btn accent" onClick={oauth} disabled={api.pending}>
              Continue with OAuth
            </button>
          </div>
        </div>
      ) : null}
      <div className="auth-box">
        <b style={{ fontSize: 12.5 }}>Header credential</b>
        <div className="fld-row">
          <Input id="hd-name" label="Header name" value={headerName} onChange={setHeaderName} />
          <div className="fld">
            <label htmlFor="hd-token">Credential value</label>
            <input id="hd-token" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder={authenticated ? 'stored · enter a new value to replace it' : ''} />
            <span className="hint">write-only · e.g. Bearer &lt;token&gt;</span>
          </div>
        </div>
        <div>
          <button type="button" className="btn" onClick={header} disabled={api.pending}>
            Save credential and discover
          </button>
        </div>
      </div>
    </div>
  );
}

/** Step 3 "Authenticate" of the admin wizard. */
export function StepAuth({ connection, area, api }: { connection: Connection | null; area: McpArea; api: StepApi }) {
  if (!connection) return <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.go('url'))} />;
  const ready = connection.lastSyncAt !== null && connection.stage !== 'AUTHENTICATE';
  return (
    <form
      id={STEP_FORM}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) api.go('review');
        else api.fail('Authenticate first: the server has not listed its tools to OCSO yet.');
      }}
      style={{ display: 'grid', gap: 12 }}
    >
      <AuthPanel connection={connection} area={area} api={api} onDiscovered={() => api.go('review')} />
    </form>
  );
}
