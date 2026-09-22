'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { formatAge, formatDuration } from '@/lib/format';
import { QueueFormModal, type Option, type QueueDraft } from './queue-form-modal';

export interface QueueRowView extends QueueDraft {
  waiting: number;
  oldestWaitingSince: string | null;
  onShift: number;
  members: number;
  breaches: number;
}

function routing(q: QueueRowView): { title: string; caption: string } {
  if (q.mode === 'AUTO_ASSIGN') return { title: 'Auto-assign', caption: `accept within ${formatDuration(q.acceptTimeoutSeconds)}` };
  return { title: 'Open pickup', caption: q.autoAssignAfterSeconds ? `auto-assign after ${formatDuration(q.autoAssignAfterSeconds)}` : 'claimed by eligible execs' };
}

function columns(teamNames: Map<string, string>, policyNames: Map<string, string>, onEdit: ((q: QueueRowView) => void) | null): Column<QueueRowView>[] {
  const cols: Column<QueueRowView>[] = [
    { key: 'queue', header: 'Queue', cell: (q) => <CellTitle title={q.name} caption={q.description ?? undefined} /> },
    { key: 'mode', header: 'Routing', cell: (q) => <CellTitle title={routing(q).title} caption={routing(q).caption} /> },
    { key: 'teams', header: 'Teams', cell: (q) => <span className="mono-sm">{q.teamIds.map((id) => teamNames.get(id) ?? 'unknown team').join(', ') || 'no teams'}</span> },
    {
      key: 'skills',
      header: 'Skills · languages',
      cell: (q) => <span className="mono-sm">{[q.requiredSkills.join(', ') || 'any skill', q.languages.join(', ') || 'any language'].join(' · ')}{q.preferAccountOwner ? ' · owner first' : ''}</span>,
    },
    {
      key: 'sla',
      header: 'SLA policy',
      cell: (q) =>
        q.slaPolicyId ? (
          <Link className="mono-sm" href={`/sla#sla-${q.slaPolicyId}`}>
            {policyNames.get(q.slaPolicyId) ?? 'policy'}
          </Link>
        ) : (
          <span className="mono-sm" style={{ color: 'var(--warn)' }}>
            none · no clock
          </span>
        ),
    },
    {
      key: 'waiting',
      header: 'Waiting',
      cell: (q) => (
        <span className="mono">
          {q.waiting}
          {q.oldestWaitingSince ? <span className="mono-sm" style={{ display: 'block' }}>oldest {formatAge(q.oldestWaitingSince)}</span> : null}
        </span>
      ),
    },
    { key: 'shift', header: 'On shift', cell: (q) => <span className="mono" title="available members / members of the queue's teams">{`${q.onShift} / ${q.members}`}</span> },
    { key: 'breaches', header: 'Past SLA', cell: (q) => <span className="mono" style={q.breaches > 0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{q.breaches}</span> },
  ];
  if (onEdit) {
    cols.push({
      key: 'edit',
      header: '',
      cell: (q) => (
        <button type="button" className="btn tiny" onClick={() => onEdit(q)} aria-label={`Edit ${q.name}`}>
          Edit
        </button>
      ),
    });
  }
  return cols;
}

/** Queue configuration + live counts; leads with queues.manage create and edit (design/02 Routing tab facts, .dtable). */
export function QueuesManager({ queues, teams, policies, canManage }: { queues: QueueRowView[]; teams: Option[]; policies: Option[]; canManage: boolean }) {
  const [editing, setEditing] = useState<QueueRowView | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const saved = useCallback((message: string) => {
    setEditing(null);
    setNotice(message);
  }, []);
  const teamNames = new Map(teams.map((t) => [t.value, t.label]));
  const policyNames = new Map(policies.map((p) => [p.value, p.label]));

  return (
    <>
      <SecHead
        title="Queues"
        count={queues.length}
        desc="where escalations wait for a human, who is eligible and which SLA clock runs"
        actions={
          <>
            <span className="mono-sm" role="status" aria-live="polite">
              {notice}
            </span>
            {canManage ? (
              <button type="button" className="btn tiny accent" onClick={() => setEditing('new')}>
                New queue
              </button>
            ) : null}
          </>
        }
      />
      <div className="ops-scroll">
        <DataTable
          label="Queues"
          columns={columns(teamNames, policyNames, canManage ? setEditing : null)}
          rows={queues}
          rowKey={(q) => q.id}
          template={`minmax(150px,1.3fr) minmax(120px,1fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,0.9fr) 70px 64px 64px${canManage ? ' 56px' : ''}`}
          empty={
            <EmptyState title="No queues yet" actions={canManage ? <button type="button" className="btn tiny accent" onClick={() => setEditing('new')}>New queue</button> : null}>
              Queues hold escalated conversations until an eligible exec picks them up or is assigned. Create one per team or skill, then point agents&apos; default queue and
              escalation rules at it.
            </EmptyState>
          }
        />
      </div>
      {editing ? <QueueFormModal queue={editing === 'new' ? null : editing} teams={teams} policies={policies} onClose={close} onSaved={saved} /> : null}
    </>
  );
}
