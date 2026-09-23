'use client';

import { useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { ChannelMark } from '@/components/ui/channel-mark';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { ChannelMarkView } from '@/lib/channels';
import { updateAgentAction } from '@/lib/actions/agents';
import { useAgentAction } from '../shared/use-action';

export interface ChannelRow {
  id: string;
  name: string;
  kind: string;
  /** The channel kind's mark, from its descriptor. */
  mark: ChannelMarkView | null;
  status: string;
  defaultAgent: 'this' | 'other' | 'none';
  defaultAgentName: string | null;
  volume: string;
  containment: string;
  csat: string;
}

const STATUS_TONE: Readonly<Record<string, StatusTone>> = { ACTIVE: 'good', DRAFT: 'muted', DISABLED: 'warn' };
const TEMPLATE = 'minmax(0,1.3fr) 84px 92px minmax(0,1fr) 84px 96px 70px';

/** Which channels this agent answers on (agent_channels); the channel's default agent is set by the Tech admin. */
export function ChannelAssignment({ agentId, rows, assigned, canEdit }: { agentId: string; rows: ChannelRow[]; assigned: string[]; canEdit: boolean }) {
  const [picked, setPicked] = useState<string[]>(assigned);
  const action = useAgentAction();
  const dirty = [...picked].sort().join() !== [...assigned].sort().join();
  return (
    <>
      <div className="dtable" role="table" aria-label="Channels">
        <div className="dt-head" role="row" style={{ gridTemplateColumns: TEMPLATE }}>
          {['Channel', 'Status', 'Assigned', 'Default agent', 'Volume', 'Containment', 'CSAT'].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {rows.map((r) => {
          const on = picked.includes(r.id);
          // A channel answers as one agent: one another agent already answers on cannot be picked here.
          const takenBy = !on && r.defaultAgent === 'other' ? (r.defaultAgentName ?? 'another agent') : null;
          return (
            <div className="dt-row" role="row" key={r.id} style={{ gridTemplateColumns: TEMPLATE }}>
              <span role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {r.mark ? <ChannelMark mark={r.mark} /> : null}
                <span style={{ minWidth: 0 }}>
                  {r.name}
                  <span className="mono-sm row-note">{r.kind.toLowerCase()}</span>
                </span>
              </span>
              <span role="cell">
                <StatusChip tone={STATUS_TONE[r.status] ?? 'muted'}>{r.status.toLowerCase()}</StatusChip>
              </span>
              <span role="cell" className="grant-cell">
                {canEdit && !takenBy ? (
                  <label className="grant-cell">
                    <input type="checkbox" checked={on} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} aria-label={`Assign ${r.name}`} />
                    {on ? 'yes' : 'no'}
                  </label>
                ) : canEdit && takenBy ? (
                  <label className="grant-cell" title={`${r.name} answers as ${takenBy}. Release it there first.`}>
                    <input type="checkbox" checked={false} disabled aria-label={`Assign ${r.name} (answers as ${takenBy})`} />
                    <span className="row-note">in use</span>
                  </label>
                ) : (
                  <StatusChip tone={on ? 'good' : 'muted'}>{on ? 'assigned' : 'not assigned'}</StatusChip>
                )}
              </span>
              <span role="cell" className="mono-sm">
                {r.defaultAgent === 'this' ? 'this agent' : r.defaultAgent === 'other' ? (r.defaultAgentName ?? 'another agent') : 'none'}
              </span>
              <span role="cell" className="mono">
                {r.volume}
              </span>
              <span role="cell" className="mono">
                {r.containment}
              </span>
              <span role="cell" className="mono">
                {r.csat}
              </span>
            </div>
          );
        })}
      </div>
      {action.error ? (
        <AlertBanner tone="error" style={{ marginTop: 14 }}>
          {action.error}
        </AlertBanner>
      ) : null}
      {canEdit ? (
        <div className="rowsplit" style={{ marginTop: 14 }}>
          <button type="button" className="btn accent" disabled={!dirty || action.pending} onClick={() => action.run(() => updateAgentAction(agentId, { channelIds: picked }))}>
            {action.pending ? 'Saving…' : 'Save channels'}
          </button>
          <button type="button" className="btn ghost" disabled={!dirty || action.pending} onClick={() => setPicked(assigned)}>
            Reset
          </button>
        </div>
      ) : null}
    </>
  );
}
