'use client';

import { useId, useState, useTransition } from 'react';
import { ROLE_LABELS } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { StatusChip } from '@/components/ui/status-chip';
import { addTeamMemberAction } from '@/lib/actions/team-membership';
import { ROLE_TONE } from './labels';
import { eligibleMembers } from './lib/membership';
import { useTeamScope } from './scope-context';

const SHOWN = 8;

/**
 * Searchable list of people the viewer may add (Tech Admin: anyone active;
 * CS Lead: CS Execs). Each result has its own Add button.
 */
export function AddMember({ teamId, teamName, memberIds }: { teamId: string; teamName: string; memberIds: string[] }) {
  const scope = useTeamScope();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const inputId = useId();
  const all = eligibleMembers(scope.viewer, teamId, scope.people, memberIds);
  const matches = eligibleMembers(scope.viewer, teamId, scope.people, memberIds, query);
  const leadOnly = !scope.viewer.manageAll;

  const add = (userId: string, name: string) =>
    start(async () => {
      const r = await addTeamMemberAction(teamId, userId, name);
      setResult(r.ok ? { ok: true, message: `Added ${name} to ${teamName}` } : r);
      if (r.ok) setQuery('');
    });

  return (
    <div className="tm-add">
      <label htmlFor={inputId} className="grp">
        Add member
      </label>
      <input id={inputId} type="search" className="tm-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" autoComplete="off" disabled={!all.length} />
      {result ? (
        result.ok ? (
          <span className="mono-sm" role="status">
            {result.message}
          </span>
        ) : (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {result.message}
          </AlertBanner>
        )
      ) : null}
      {matches.length ? (
        <ul className="tm-pick" aria-label="People you can add">
          {matches.slice(0, SHOWN).map((p) => (
            <li key={p.id}>
              <span className="tm-who">
                <b>{p.name}</b>
                <StatusChip tone={ROLE_TONE[p.role]}>{ROLE_LABELS[p.role]}</StatusChip>
              </span>
              <button type="button" className="btn tiny" disabled={pending} aria-label={`Add ${p.name}`} onClick={() => add(p.id, p.name)}>
                Add
              </button>
              <span className="tm-meta mono-sm">{p.email}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mono-sm">{all.length ? 'Nobody matches that search.' : leadOnly ? 'Every CS Exec is already in this team.' : 'Everyone active is already in this team.'}</p>
      )}
      {matches.length > SHOWN ? <p className="mono-sm">{matches.length - SHOWN} more · refine the search</p> : null}
      {leadOnly ? <p className="mono-sm">CS Leads add CS Execs. A Platform Tech Admin adds other leads.</p> : null}
    </div>
  );
}
