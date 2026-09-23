'use client';

import Link from 'next/link';
import { useState } from 'react';
import { teamEditMode, type Person } from './lib/membership';
import { useTeamScope } from './scope-context';
import { UserTeamsModal } from './user-teams-modal';

/** A person's teams as chips (each opens the team drawer), plus "Edit teams" when the viewer may change them. */
export function UserTeams({ person }: { person: Person }) {
  const scope = useTeamScope();
  const [open, setOpen] = useState(false);
  const mode = teamEditMode(scope.viewer, person);
  const names = new Map(scope.teams.map((t) => [t.id, t.name]));
  const teams = person.teamIds.filter((id) => names.has(id)).sort((a, b) => (names.get(a) ?? '').localeCompare(names.get(b) ?? ''));

  return (
    <span className="tm-chips">
      {teams.length ? (
        teams.map((id) => (
          <Link key={id} href={`/team?team=${id}`} scroll={false} className="chip">
            {names.get(id)}
          </Link>
        ))
      ) : (
        <span className="mono-sm">no team</span>
      )}
      {mode ? (
        <button type="button" className="btn tiny ghost" aria-label={`Edit teams of ${person.name}`} onClick={() => setOpen(true)}>
          Edit
        </button>
      ) : null}
      {open && mode ? <UserTeamsModal person={person} mode={mode} scope={scope} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}
