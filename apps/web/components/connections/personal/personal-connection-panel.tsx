'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { KeyValue } from '@/components/ui/key-value';
import { Modal } from '@/components/ui/modal';
import { StatusChip } from '@/components/ui/status-chip';
import { checkHealthAction, deleteConnectionAction, discoverAction } from '@/lib/actions/mcp';
import type { Connection, Tool } from '@/lib/api/mcp';
import { formatAge, formatLatency } from '@/lib/format';
import { ConfirmAction } from '../confirm-action';
import { ToolReview, initialDecisions } from '../mcp/tool-review';
import { AuthPanel } from '../mcp/wizard/step-auth';
import { connectionStatus } from '../mcp/meta';
import { useCloseTo } from '../routed-modal';

/**
 * One of the user's own connections: authenticate it (OAuth or header
 * credential), check it, see the tools it inherits from the admin's
 * classification, or disconnect it (credentials are revoked).
 */
export function PersonalConnectionPanel({ connection: c, tools, closeHref }: { connection: Connection; tools: Tool[]; closeHref: string }) {
  const close = useCloseTo(closeHref);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const status = connectionStatus(c);
  const needsAuth = c.status === 'AUTH_REQUIRED' || c.stage === 'AUTHENTICATE';
  const api = {
    pending,
    run: (task: () => Promise<void>) => {
      setError(null);
      start(task);
    },
    fail: setError,
    notify: setNote,
  };

  function rediscover() {
    api.run(async () => {
      const r = await discoverAction(c.id, 'personal');
      if (!r.ok) setError(r.message);
      else setNote(r.data.message);
    });
  }

  function check() {
    api.run(async () => {
      const r = await checkHealthAction(c.id, 'personal');
      if (!r.ok) setError(r.message);
      else setNote(`Health: ${r.data.health.toLowerCase().replace(/_/g, ' ')} · ${formatLatency(r.data.latencyMs)} · ${r.data.detail}`);
    });
  }

  return (
    <Modal
      title={c.name}
      sub="your connection · only you can use it"
      onClose={close}
      maxWidth={680}
      footer={
        <>
          <ConfirmAction label="Disconnect" buttonClass="btn danger" title={`Disconnect ${c.name}`} confirmLabel="Disconnect" run={() => deleteConnectionAction(c.id, 'personal')} onDone={close}>
            Your stored credential is revoked and the connection is removed. You can connect again later.
          </ConfirmAction>
          <span className="sp" />
          <button type="button" className="btn" onClick={rediscover} disabled={pending}>
            Discover again
          </button>
          <button type="button" className="btn" onClick={check} disabled={pending || !c.approvedAt}>
            Check health
          </button>
          <button type="button" className="btn accent" onClick={close}>
            Done
          </button>
        </>
      }
    >
      <div role="status" aria-live="polite" style={{ display: 'grid', gap: 8 }}>
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
        {note && !error ? (
          <AlertBanner style={{ margin: 0 }}>
            <span className="a-body">{note}</span>
          </AlertBanner>
        ) : null}
      </div>
      <div className="rowsplit">
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
        <span className="mono-sm">{c.url}</span>
      </div>
      <KeyValue
        items={[
          { k: 'tools', v: `${c.tools.approved} approved by your admin of ${c.tools.total}` },
          { k: 'health', v: c.health.checkedAt ? `${c.health.status?.toLowerCase() ?? '—'} · ${formatAge(c.health.checkedAt)} ago` : 'no check yet' },
          ...(c.lastError ? [{ k: 'last error', v: c.lastError }] : []),
        ]}
      />
      {needsAuth || c.auth.strategy === 'NONE' ? (
        <AuthPanel connection={c} area="personal" api={api} onDiscovered={() => undefined} />
      ) : (
        <span className="mono-sm">Authenticated · your credential is stored by reference. Use “Discover again” after changing it on the server side.</span>
      )}
      {tools.length ? <ToolReview tools={tools} decisions={initialDecisions(tools)} onChange={() => undefined} readOnly /> : null}
    </Modal>
  );
}
