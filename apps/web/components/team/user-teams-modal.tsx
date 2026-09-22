'use client';

import { useState, useTransition } from 'react';
import { ROLE_LABELS } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { saveUserTeamsAction } from '@/lib/actions/team-membership';
import { removalFor, teamChoices, teamDiff, type Person, type TeamEditMode, type TeamScope } from './lib/membership';
import { RemovalConfirm } from './removal-confirm';

const HINT: Record<TeamEditMode, string> = {
  admin: 'CS Leads manage the agents their teams own; everyone gets work from the queues their teams serve.',
  exec: 'You change only your own teams. The exec’s other teams are shown locked.',
  self: 'You can leave your teams here. Joining another team needs a Platform Tech Admin.',
};

/** Edit one person's teams from the People table; removals are confirmed with their consequences first. */
export function UserTeamsModal({ person, mode, scope, onClose }: { person: Person; mode: TeamEditMode; scope: TeamScope; onClose: () => void }) {
  const choices = teamChoices(mode, scope.viewer, person, scope.teams);
  const [selected, setSelected] = useState<string[]>([...person.teamIds]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { added, removed } = teamDiff(person.teamIds, selected);
  const self = person.id === scope.viewer.id;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveUserTeamsAction(person.id, [...person.teamIds], selected);
      if (r.ok) onClose();
      else setError(r.message);
    });
  const submit = () => {
    if (!added.length && !removed.length) return onClose();
    if (removed.length) return setConfirming(true);
    save();
  };

  if (confirming) {
    const names = scope.teams.filter((t) => removed.includes(t.id)).map((t) => t.name);
    return (
      <RemovalConfirm
        title={self ? 'Leave teams' : 'Change teams'}
        question={self ? `Leave ${names.join(', ')}?` : `Remove ${person.name} from ${names.join(', ')}${added.length ? ' and add the new teams' : ''}?`}
        effect={removalFor(scope, person, removed, added)}
        confirmLabel={self ? 'Leave team' : 'Save teams'}
        pending={pending}
        error={error}
        onConfirm={save}
        onClose={() => setConfirming(false)}
      />
    );
  }

  return (
    <Modal
      title={`Teams · ${person.name}`}
      sub={ROLE_LABELS[person.role]}
      onClose={onClose}
      maxWidth={520}
      footer={
        <>
          <span className="mono-sm">{added.length || removed.length ? `${added.length} to add · ${removed.length} to remove` : 'no changes'}</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className="btn accent" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save teams'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        {error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error}
          </AlertBanner>
        ) : null}
        {choices.length ? (
          <fieldset className="checks" style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="sr-only">Teams</legend>
            {choices.map((c) => (
              <label key={c.id} title={c.locked ? 'A team you are not in: its leads or a Platform Tech Admin can change it' : undefined}>
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  disabled={c.locked || pending}
                  onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                />
                {c.name}
                {c.locked ? ' · not your team' : ''}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="mono-sm">No teams exist yet. A CS Lead creates teams on this page.</p>
        )}
        <p className="mono-sm" style={{ margin: 0 }}>
          {HINT[mode]}
        </p>
      </div>
    </Modal>
  );
}
