'use client';

import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { discoverAction } from '@/lib/actions/mcp';
import type { Connection } from '@/lib/api/mcp';
import { formatLatency } from '@/lib/format';
import { serverInfoSummary } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';

/** Step 2 "Discover server": what the server declared (server-provided text is shown as plain text). */
export function StepDiscover({ connection, api }: { connection: Connection | null; api: StepApi }) {
  if (!connection) return <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.go('url'))} />;
  const info = serverInfoSummary(connection.serverInfo);
  const discovered = connection.lastSyncAt !== null;
  const needsAuth = connection.stage === 'AUTHENTICATE' || (!discovered && info.authRequired !== null);

  function submit() {
    if (!connection) return;
    if (discovered || needsAuth) {
      api.go('auth');
      return;
    }
    const id = connection.id;
    api.run(async () => {
      const r = await discoverAction(id, 'connections');
      if (!r.ok) api.fail(r.message);
      else {
        api.notify(r.data.message);
        api.go('auth');
      }
    });
  }

  return (
    <form id={STEP_FORM} noValidate onSubmit={(e) => (e.preventDefault(), submit())} style={{ display: 'grid', gap: 12 }}>
      <div className="rowsplit">
        <span className="mono-sm">{connection.url}</span>
        <span className="sp" />
        {discovered ? <StatusChip tone="good">tools listed</StatusChip> : needsAuth ? <StatusChip tone="warn">auth required</StatusChip> : <StatusChip tone="danger">not discovered</StatusChip>}
      </div>
      {discovered ? (
        <KeyValue
          items={[
            { k: 'server', v: `${info.name ?? 'unnamed server'}${info.version ? ` · v${info.version}` : ''}` },
            { k: 'protocol', v: `${connection.protocolVersion ?? 'unknown'}${info.protocolEra ? ` · ${info.protocolEra} era` : ''}` },
            { k: 'capabilities', v: info.capabilities.length ? info.capabilities.join(' · ') : 'none declared' },
            { k: 'tools found', v: String(connection.tools.total) },
            { k: 'response', v: formatLatency(info.latencyMs) },
            { k: 'auth', v: connection.auth.strategy === 'NONE' ? 'none needed so far' : connection.auth.strategy === 'OAUTH' ? 'OAuth 2.1' : 'header credential' },
          ]}
        />
      ) : null}
      {info.instructions ? (
        <div className="server-text">
          <span className="mono-sm">server instructions (untrusted, shown as text; never sent to the model as instructions)</span>
          <p>{info.instructions}</p>
        </div>
      ) : null}
      {needsAuth && info.authRequired ? (
        <AlertBanner tone="warn" style={{ margin: 0 }} title="The server requires authentication.">
          {`Reason: ${info.authRequired.reason.replace(/_/g, ' ')}. ${info.authRequired.oauthAvailable ? 'It publishes OAuth metadata, so OCSO can run the OAuth 2.1 flow.' : 'It publishes no OAuth metadata; use a header credential.'}`}
        </AlertBanner>
      ) : null}
      {!discovered && !needsAuth ? (
        <AlertBanner tone="error" style={{ margin: 0 }} title="Discovery has not succeeded yet.">
          {connection.lastError ?? 'Run discovery to read the server’s tools.'}
        </AlertBanner>
      ) : null}
      {discovered && connection.tools.total > 0 ? (
        <AlertBanner style={{ margin: 0 }}>
          <span className="a-body">You will classify every tool’s side effects and approve them in the next steps; nothing is exposed until then.</span>
        </AlertBanner>
      ) : null}
    </form>
  );
}
