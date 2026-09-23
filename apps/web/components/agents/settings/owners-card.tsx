'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { ChartCard } from '@/components/ui/rail-card';
import { setAgentOwnersAction } from '@/lib/actions/agents';
import { handOffWarning, ownerChoices, ownerLabel, ownerProblem, type OwnerMode, type TeamRef } from '../lib/owners';
import { useAgentAction } from '../shared/use-action';

interface Props {
  agentId: string;
  owners: TeamRef[];
  /** null: read-only (the user cannot change ownership). */
  mode: OwnerMode | null;
  teams: TeamRef[];
  myTeamIds: string[];
}

const DESC: Record<OwnerMode | 'read', string> = {
  lead: 'Leads of these teams manage this agent; others cannot see it. You can add or remove your own teams.',
  admin: 'Governance: reassign the teams whose Leads manage this agent, e.g. when a lead leaves. The change is audited.',
  read: 'Leads of these teams manage this agent.',
};

/** "Owning teams" card on the Settings tab (ADR-026). */
export function OwnersCard({ agentId, owners, mode, teams, myTeamIds }: Props) {
  const router = useRouter();
  const action = useAgentAction();
  const choices = mode ? ownerChoices(mode, teams, owners, myTeamIds) : [];
  const [selected, setSelected] = useState<string[]>(choices.filter((c) => c.checked).map((c) => c.id));
  const [saved, setSaved] = useState(false);
  const problem = ownerProblem(selected);
  const warning = mode ? handOffWarning(mode, selected, myTeamIds) : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem) return;
    setSaved(false);
    action.run(
      () => setAgentOwnersAction(agentId, selected),
      () => {
        setSaved(true);
        // A hand-off removes the lead's access: leave the page instead of rendering a 404.
        if (warning) router.push('/agents');
      },
    );
  }

  return (
    <ChartCard title="Owning teams" meta={<span className="mono-sm">{ownerLabel(owners)}</span>}>
      <p className="mono-sm" style={{ margin: '0 0 10px' }}>
        {DESC[mode ?? 'read']}
      </p>
      {mode ? (
        <form onSubmit={submit} aria-label="Owning teams">
          {choices.length ? (
            <fieldset className="checks" style={{ border: 'none', padding: 0, margin: 0 }}>
              <legend className="sr-only">Owning teams</legend>
              {choices.map((c) => (
                <label key={c.id} title={c.locked ? 'Owned by a team you are not in: its leads or the Tech admin can change it' : undefined}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    disabled={c.locked || action.pending}
                    onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                  />
                  {c.name}
                  {c.locked ? ' · not your team' : ''}
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="mono-sm">No teams exist yet. A Lead creates teams on the Team page.</p>
          )}
          {problem ? <p className="err-text" role="alert">{problem}</p> : null}
          {warning ? <AlertBanner tone="warn" style={{ margin: '10px 0 0' }}>{warning}</AlertBanner> : null}
          {action.error ? <AlertBanner tone="error" style={{ margin: '10px 0 0' }}>{action.error}</AlertBanner> : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
            <button type="submit" className="btn" disabled={action.pending || !!problem}>
              {action.pending ? 'Saving…' : 'Save owning teams'}
            </button>
            {saved && !action.error ? <span className="mono-sm" role="status">Owning teams saved</span> : null}
          </div>
        </form>
      ) : null}
    </ChartCard>
  );
}
