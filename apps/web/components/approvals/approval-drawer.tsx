'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Drawer } from '@/components/ui/drawer';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { withdrawApprovalAction } from '@/lib/actions/approvals';
import { formatDateTime } from '@/lib/format';
import { ApprovalDiff } from './approval-diff';
import { ApprovalSnapshot } from './approval-snapshot';
import { DecisionForm } from './decision-form';
import { ACTION_LABEL, statusChip } from './lib/labels';
import type { ProposalDetail } from './lib/schemas';
import { ReassignForm } from './reassign-form';
import { VoidForm } from './void-form';

/**
 * One proposal: what would change (diff), why, who made and checks it, its
 * warnings and history, and the actions this viewer may take (decide,
 * reassign, withdraw). Server data; re-keyed on status/revision/checker.
 */
export function ApprovalDrawer({
  proposal: p,
  candidates,
  reassignAny,
  timeZone,
  closeHref,
}: {
  proposal: ProposalDetail;
  candidates: Array<{ id: string; name: string; role: string | null }>;
  reassignAny: boolean;
  timeZone: string;
  closeHref: string;
}) {
  const router = useRouter();
  const [withdrawing, startWithdraw] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const chip = statusChip(p);
  const blocking = p.warnings.some((w) => w.blocksBulk);
  return (
    <Drawer
      title={p.title}
      sub={`${p.objectLabel} · ${ACTION_LABEL[p.action] ?? p.action} · revision ${p.revision}`}
      onClose={() => router.replace(closeHref, { scroll: false })}
      footer={
        p.canDecide ? (
          <DecisionForm id={p.id} contentHash={p.contentHash} dependencyHash={p.dependencyHash} blocking={blocking} />
        ) : p.status === 'SUBMITTED' ? (
          <span className="mono-sm">{p.maker && p.checker ? `Waiting for ${p.checker.name} to decide.` : 'Waiting for a decision.'}</span>
        ) : undefined
      }
    >
      <div className="rowsplit" style={{ gap: 6 }}>
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
        {p.origin === 'MIGRATION' ? <StatusChip tone="muted">predates maker–checker</StatusChip> : null}
      </div>
      {p.warnings.length ? (
        <AlertBanner tone={blocking ? 'error' : 'warn'} title={blocking ? 'Check before deciding' : 'Note'} style={{ margin: 0 }}>
          {p.warnings.map((w) => w.message).join(' ')}
        </AlertBanner>
      ) : null}
      {p.problems.length ? (
        <AlertBanner tone="error" title="Would be blocked at activation" style={{ margin: 0 }}>
          {p.problems.map((x) => x.message).join(' ')}
        </AlertBanner>
      ) : null}
      {error ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {error}
        </AlertBanner>
      ) : null}
      <KeyValue
        template="minmax(96px,112px) minmax(0,1fr)"
        items={[
          { k: 'reason', v: p.reason },
          { k: 'maker', v: p.maker?.name ?? 'migration' },
          { k: 'checker', v: `${p.checker?.name ?? '—'}${p.checkerValid ? '' : ' (can no longer approve)'}` },
          { k: 'submitted', v: formatDateTime(p.submittedAt, timeZone) },
          ...(p.decidedAt ? [{ k: 'decided', v: `${formatDateTime(p.decidedAt, timeZone)}${p.decidedBy ? ` · ${p.decidedBy.name}` : ''}` }] : []),
          ...(p.decisionReason ? [{ k: 'decision note', v: p.decisionReason }] : []),
          ...(p.blockedReason ? [{ k: 'blocked', v: p.blockedReason }] : []),
          { k: 'content hash', v: <span className="mono-sm">{p.contentHash}</span> },
        ]}
      />
      <div>
        <div className="grp" style={{ marginBottom: 6 }}>
          what changes
        </div>
        <ApprovalDiff fields={p.diff} />
      </div>
      {p.action === 'ACTIVATE' && p.after ? (
        <details className="ap-live" open={p.canDecide}>
          <summary className="grp">what goes live</summary>
          <ApprovalSnapshot snapshot={p.after} />
        </details>
      ) : null}
      {p.canReassign && (reassignAny || p.canDecide || !p.checkerValid) ? (
        <div>
          <div className="grp" style={{ marginBottom: 6 }}>
            reassign
          </div>
          <ReassignForm id={p.id} candidates={candidates} />
        </div>
      ) : null}
      {p.canVoid ? (
        <div>
          <div className="grp" style={{ marginBottom: 6 }}>
            void
          </div>
          <VoidForm id={p.id} />
        </div>
      ) : null}
      {p.canWithdraw ? (
        <button
          type="button"
          className="btn tiny ghost"
          disabled={withdrawing}
          onClick={() =>
            startWithdraw(async () => {
              const r = await withdrawApprovalAction(p.id, 'Withdrawn by the maker');
              if (!r.ok) setError(r.message);
            })
          }
        >
          Withdraw this proposal
        </button>
      ) : null}
      <div>
        <div className="grp" style={{ marginBottom: 6 }}>
          history
        </div>
        <ol className="ap-history">
          {p.decisions.map((d) => (
            <li key={d.id}>
              <span className="mono-sm">{formatDateTime(d.occurredAt, timeZone)}</span>
              <span>
                <b>{d.kind.toLowerCase().replace(/_/g, ' ')}</b> · {d.actorName}
                {d.reason ? ` — ${d.reason}` : ''}
                {d.bulkBatchId ? <span className="mono-sm"> (bulk)</span> : null}
                {d.via === 'INTERNAL_AGENT' ? <span className="mono-sm"> via Ask OCSO</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Drawer>
  );
}
