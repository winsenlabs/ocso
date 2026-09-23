'use client';

import { useState, useTransition } from 'react';
import { ROLE_LABELS, type Role } from '@ocso/auth';
import { Presence } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import { removeTeamMemberAction } from '@/lib/actions/team-membership';
import { AVAILABILITY, ROLE_TONE } from './labels';
import { canChangeMembership, removalFor } from './lib/membership';
import { RemovalConfirm } from './removal-confirm';
import { useTeamScope } from './scope-context';

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  availability: keyof typeof AVAILABILITY;
  /** "added 22 Sep 2026, 14:05", formatted on the server in the deployment timezone. */
  addedLabel: string;
}

/** Members of a team with per-row Remove / Leave (confirmed with its consequences). */
export function TeamMembers({ teamId, teamName, members }: { teamId: string; teamName: string; members: MemberRow[] }) {
  const scope = useTeamScope();
  const [target, setTarget] = useState<MemberRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const self = target?.userId === scope.viewer.id;
  const person = target ? (scope.people.find((p) => p.id === target.userId) ?? { id: target.userId, name: target.name, role: target.role, teamIds: [teamId] }) : null;

  const confirm = () => {
    if (!target) return;
    start(async () => {
      const r = await removeTeamMemberAction(teamId, target.userId, target.name);
      if (!r.ok) return setError(r.message);
      setNotice(self ? `You left ${teamName}` : `Removed ${target.name} from ${teamName}`);
      setTarget(null);
    });
  };

  return (
    <>
      <span className="mono-sm" role="status" aria-live="polite">
        {notice}
      </span>
      {members.length ? (
        <ul className="tm-list" aria-label="Members">
          {members.map((m) => (
            <li key={m.userId}>
              <span className="tm-who">
                <b>{m.name}</b>
                {m.userId === scope.viewer.id ? <span className="chip accent">you</span> : null}
                <StatusChip tone={ROLE_TONE[m.role]}>{ROLE_LABELS[m.role]}</StatusChip>
                {m.status === 'DISABLED' ? <StatusChip tone="muted">disabled</StatusChip> : null}
              </span>
              {canChangeMembership(scope.viewer, teamId, { id: m.userId, role: m.role }) ? (
                <button
                  type="button"
                  className="btn tiny danger"
                  aria-label={m.userId === scope.viewer.id ? `Leave ${teamName}` : `Remove ${m.name}`}
                  onClick={() => {
                    setError(null);
                    setNotice(null);
                    setTarget(m);
                  }}
                >
                  {m.userId === scope.viewer.id ? 'Leave' : 'Remove'}
                </button>
              ) : null}
              <span className="tm-meta mono-sm">
                {m.email} · <Presence state={AVAILABILITY[m.availability].state}>{AVAILABILITY[m.availability].label}</Presence> · {m.addedLabel}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mono-sm">No members. A team without members routes no work and manages no agents.</p>
      )}
      {target && person ? (
        <RemovalConfirm
          title={self ? `Leave ${teamName}` : `Remove from ${teamName}`}
          question={self ? `Leave ${teamName}?` : `Remove ${target.name} (${ROLE_LABELS[target.role]}) from ${teamName}?`}
          effect={removalFor(scope, person, [teamId])}
          confirmLabel={self ? 'Leave team' : 'Remove member'}
          pending={pending}
          error={error}
          onConfirm={confirm}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>
  );
}
