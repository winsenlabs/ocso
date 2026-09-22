'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Drawer } from '@/components/ui/drawer';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { acknowledgeAlertAction, resolveAlertAction } from '@/lib/actions/alerts';
import type { AlertDetail } from '@/lib/api/alerts';
import { formatDateTime } from '@/lib/format';
import { KindChip, SeverityChip, StateChip } from './alert-chips';
import { DELIVERY_TONE, ROLE_LABEL } from './alerts-meta';

/**
 * Alert detail drawer: what fired and why (the rule's own explanation), where
 * it was delivered, and the lifecycle actions — acknowledge (optional note)
 * and resolve (note required). Both are audited by the API.
 */
export function AlertDrawer({
  alert: a,
  names,
  canAct,
  timeZone,
  closeHref,
}: {
  alert: AlertDetail;
  names: Record<string, string>;
  canAct: boolean;
  timeZone: string;
  closeHref: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const who = (id: string | null) => (id ? (names[id] ?? `user ${id.slice(0, 8)}`) : 'automation');
  const close = () => router.replace(closeHref, { scroll: false });

  function act(kind: 'ack' | 'resolve') {
    setMessage(null);
    start(async () => {
      const r = kind === 'ack' ? await acknowledgeAlertAction(a.id, note) : await resolveAlertAction(a.id, note);
      if (!r.ok) setMessage({ tone: 'error', text: r.message });
      else {
        setMessage({ tone: 'info', text: kind === 'ack' ? 'Acknowledged · recorded in the audit log' : 'Resolved · recorded in the audit log' });
        setNote('');
      }
    });
  }

  const context = Object.entries(a.context).filter(([k]) => k !== 'agentId');
  return (
    <Drawer
      title={a.title}
      sub={`${a.kind.toLowerCase()} · ${a.source} · opened ${formatDateTime(a.openedAt, timeZone)}`}
      onClose={close}
      footer={
        canAct && a.status !== 'RESOLVED' ? (
          <div className="al-actions">
            <label className="mono-sm" htmlFor="alert-note">
              note {a.status === 'OPEN' ? '(optional to acknowledge, required to resolve)' : '(required to resolve)'}
            </label>
            <textarea id="alert-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What you found or did" />
            <div className="rowsplit">
              {a.status === 'OPEN' ? (
                <button type="button" className="btn" disabled={pending} onClick={() => act('ack')}>
                  Acknowledge
                </button>
              ) : null}
              <button type="button" className="btn accent" disabled={pending || !note.trim()} onClick={() => act('resolve')}>
                Resolve
              </button>
              <span className="sp" />
              {pending ? <span className="mono-sm">working…</span> : null}
            </div>
          </div>
        ) : undefined
      }
    >
      <div aria-live="polite">
        {message ? (
          <AlertBanner tone={message.tone} style={{ margin: 0 }}>
            {message.text}
          </AlertBanner>
        ) : null}
      </div>
      <div className="rowsplit" style={{ gap: 6 }}>
        <StateChip status={a.status} />
        <SeverityChip severity={a.severity} />
        <KindChip kind={a.kind} />
        {a.value ? <span className="mono-sm">{a.value}</span> : null}
      </div>
      <p className="al-body">{a.body}</p>
      <KeyValue
        template="minmax(96px,112px) minmax(0,1fr)"
        items={[
          { k: 'rule', v: a.ruleName ? `${a.ruleName}${a.condition ? ` · ${a.condition}` : ''}` : 'rule deleted' },
          { k: 'audience', v: a.audienceRoles.map((r) => ROLE_LABEL[r] ?? r).join(', ') },
          { k: 'occurrences', v: `${a.occurrences} · last seen ${formatDateTime(a.lastSeenAt, timeZone)}` },
          { k: 'acknowledged', v: a.acknowledgedAt ? `${formatDateTime(a.acknowledgedAt, timeZone)} · ${who(a.acknowledgedBy)}` : '—' },
          { k: 'resolved', v: a.resolvedAt ? `${formatDateTime(a.resolvedAt, timeZone)} · ${who(a.resolvedBy)}` : '—' },
          ...(a.resolution ? [{ k: 'resolution', v: a.resolution }] : []),
          { k: 'fingerprint', v: <span className="mono-sm">{a.fingerprint}</span> },
        ]}
      />
      {context.length ? (
        <div>
          <div className="grp" style={{ marginBottom: 6 }}>
            correlation
          </div>
          <pre className="al-json">{JSON.stringify(Object.fromEntries(context), null, 2)}</pre>
        </div>
      ) : null}
      <div>
        <div className="grp" style={{ marginBottom: 6 }}>
          deliveries · {a.deliveries.length}
        </div>
        {a.deliveries.length === 0 ? (
          <span className="mono-sm">no destination attached to this rule</span>
        ) : (
          <div className="minitable" role="table" aria-label="Deliveries">
            {a.deliveries.map((d) => (
              <div className="r" role="row" key={d.id} style={{ gridTemplateColumns: 'minmax(0,1fr) 84px 70px' }}>
                <span role="cell">
                  {d.destinationName ?? 'deleted destination'}
                  <span className="mono-sm" style={{ display: 'block' }}>
                    {d.event.toLowerCase()} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                    {d.sentAt ? ` · ${formatDateTime(d.sentAt, timeZone)}` : ''}
                    {d.lastError ? ` · ${d.lastError}` : ''}
                  </span>
                </span>
                <span role="cell" className="mono-sm">
                  {d.destinationKind?.toLowerCase().replace(/_/g, '-') ?? '—'}
                </span>
                <span role="cell">
                  <StatusChip tone={DELIVERY_TONE[d.status] ?? 'muted'}>{d.status.toLowerCase()}</StatusChip>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
