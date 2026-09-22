'use client';

import { useCallback, useState } from 'react';
import { CreateTeamModal } from './create-team-modal';
import { CreateUserModal, type CreateUserModalProps } from './create-user-modal';

export interface TeamActionsProps {
  canCreateTeam: boolean;
  roles: CreateUserModalProps['roles'];
  teams: CreateUserModalProps['teams'];
}

/** Page-head buttons for the team directory; owns the two create dialogs. */
export function TeamActions({ canCreateTeam, roles, teams }: TeamActionsProps) {
  const [dialog, setDialog] = useState<'user' | 'team' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setDialog(null), []);
  const created = useCallback((message: string) => {
    setDialog(null);
    setNotice(message);
  }, []);

  return (
    <>
      <span className="mono-sm" role="status" aria-live="polite" style={{ alignSelf: 'center' }}>
        {notice}
      </span>
      {canCreateTeam ? (
        <button type="button" className="btn" onClick={() => setDialog('team')}>
          New team
        </button>
      ) : null}
      {roles.length ? (
        <button type="button" className="btn accent" onClick={() => setDialog('user')}>
          New user
        </button>
      ) : null}
      {dialog === 'user' ? <CreateUserModal roles={roles} teams={teams} onClose={close} onCreated={created} /> : null}
      {dialog === 'team' ? <CreateTeamModal onClose={close} onCreated={created} /> : null}
    </>
  );
}
