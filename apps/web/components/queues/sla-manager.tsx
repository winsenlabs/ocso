'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { submitSlaPolicyAction } from '@/lib/actions/queues';
import { SecHead } from '@/components/ui/sec-head';
import { formatDuration } from '@/lib/format';
import { CONVERSATION_TYPES, PRIORITY_KEYS } from './forms';
import { SlaFormModal, type SlaDraft } from './sla-form-modal';

export interface SlaCardView extends SlaDraft {
  queues: string[];
  pending: { id: string; action: string; checkerName: string | null } | null;
}

/** Draft · pending · approved (PM/research/11 §4): queues may be approved only with an approved policy. */
function ApprovalState({ p, canManage }: { p: SlaCardView; canManage: boolean }) {
  if (p.pending) {
    return (
      <Link href={`/approvals?box=sent&approval=${encodeURIComponent(p.pending.id)}`}>
        <StatusChip tone="warn">{`pending · ${p.pending.checkerName ?? 'checker'}`}</StatusChip>
      </Link>
    );
  }
  if (p.approved) return <StatusChip tone="good">approved</StatusChip>;
  return (
    <>
      <StatusChip tone="muted">draft</StatusChip>
      {canManage ? (
        <ApprovableButton
          label="Submit"
          ariaLabel={`Submit ${p.name} for approval`}
          title={`Approve SLA policy ${p.name}`}
          confirmLabel="Submit for approval"
          target={{ objectKind: 'sla_policy', objectId: p.id, title: `Approve SLA policy ${p.name}` }}
          write={(approval) => submitSlaPolicyAction(p.id, approval)}
          always
        >
          Queues can be approved with {p.name} once a checker approves it as it is now.
        </ApprovableButton>
      ) : null}
    </>
  );
}

function PolicyCard({ p, onEdit }: { p: SlaCardView; onEdit: (() => void) | null }) {
  const resolution = CONVERSATION_TYPES.filter((t) => p.resolutionSecondsByType[t] !== undefined);
  return (
    <section className="ch ops-sla" id={`sla-${p.id}`} aria-label={`SLA policy ${p.name}`}>
      <div className="t">
        <h3>{p.name}</h3>
        <span className="mono-sm">at risk after {Math.round(p.atRiskFraction * 100)}%</span>
        <ApprovalState p={p} canManage={onEdit !== null} />
        {onEdit ? (
          <button type="button" className="btn tiny" style={{ marginLeft: 'auto' }} onClick={onEdit} aria-label={`Edit ${p.name}`}>
            Edit
          </button>
        ) : null}
      </div>
      <div className="kv" style={{ gridTemplateColumns: 'minmax(120px,150px) minmax(0,1fr)' }}>
        <span className="k">first human response</span>
        <span className="mono">{formatDuration(p.firstHumanResponseSeconds)}</span>
        {PRIORITY_KEYS.map((k) => (
          <PickupRow key={k} priority={k} seconds={p.pickupSecondsByPriority[k]} fallback={p.firstHumanResponseSeconds} />
        ))}
        <span className="k">resolution</span>
        <span className="mono-sm">{resolution.length ? resolution.map((t) => `${t.toLowerCase()} ${formatDuration(p.resolutionSecondsByType[t])}`).join(' · ') : 'no targets'}</span>
        <span className="k">queues</span>
        <span>{p.queues.length ? p.queues.join(', ') : <span className="mono-sm" style={{ color: 'var(--warn)' }}>not attached to a queue</span>}</span>
      </div>
    </section>
  );
}

function PickupRow({ priority, seconds, fallback }: { priority: string; seconds: number | undefined; fallback: number }) {
  return (
    <>
      <span className="k">{priority} pickup</span>
      <span className="mono">{seconds === undefined ? <span className="mono-sm">{formatDuration(fallback)} · first response</span> : formatDuration(seconds)}</span>
    </>
  );
}

/** SLA policy cards (design/02 Routing "SLA policy" card); sla.manage creates and edits. */
export function SlaManager({ policies, canManage }: { policies: SlaCardView[]; canManage: boolean }) {
  const [editing, setEditing] = useState<SlaCardView | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const saved = useCallback((message: string) => {
    setEditing(null);
    setNotice(message);
  }, []);

  return (
    <>
      <SecHead
        title="Policies"
        count={policies.length}
        desc="pickup clocks start when a handoff is routed to a queue with a policy"
        actions={
          <>
            <span className="mono-sm" role="status" aria-live="polite">
              {notice}
            </span>
            {canManage ? (
              <button type="button" className="btn tiny accent" onClick={() => setEditing('new')}>
                New SLA policy
              </button>
            ) : null}
          </>
        }
      />
      {policies.length ? (
        <div className="g g2">
          {policies.map((p) => (
            <PolicyCard key={p.id} p={p} onEdit={canManage ? () => setEditing(p) : null} />
          ))}
        </div>
      ) : (
        <EmptyState title="No SLA policies yet" actions={canManage ? <button type="button" className="btn tiny accent" onClick={() => setEditing('new')}>New SLA policy</button> : null}>
          A policy sets the first human response and per-priority pickup targets (and resolution targets per conversation type). Attach it to a queue and every handoff
          routed there gets a pickup clock.
        </EmptyState>
      )}
      {editing ? <SlaFormModal policy={editing === 'new' ? null : editing} onClose={close} onSaved={saved} /> : null}
    </>
  );
}
