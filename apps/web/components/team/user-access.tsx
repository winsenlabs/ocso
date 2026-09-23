'use client';

import { useState, useTransition } from 'react';
import { Modal } from '@/components/ui/modal';
import { StatusChip } from '@/components/ui/status-chip';
import { userAccessAction } from '@/lib/actions/team';
import { InviteLink } from './invite-link';

export interface UserAccessProps {
  userId: string;
  name: string;
  invite: 'none' | 'pending' | 'expired' | 'accepted';
  mfaEnabled: boolean;
  active: boolean;
  /** The viewer may manage this user (Tech admin: anyone; Lead: Service members). */
  canManage: boolean;
  isSelf: boolean;
}

const INVITE_CHIP = { pending: { tone: 'warn', label: 'invite pending' }, expired: { tone: 'danger', label: 'invite expired' } } as const;

/** Sign-in state of a user plus resend-invite / reset-link actions (ADR-025). */
export function UserAccess({ userId, name, invite, mfaEnabled, active, canManage, isSelf }: UserAccessProps) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ message: string; link: string | null } | null>(null);
  const waiting = invite === 'pending' || invite === 'expired';
  const run = (kind: 'invite' | 'reset') =>
    start(async () => {
      const r = await userAccessAction(userId, kind);
      setResult({ message: r.message, link: r.ok ? r.link : null });
    });
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {waiting ? <StatusChip tone={INVITE_CHIP[invite].tone}>{INVITE_CHIP[invite].label}</StatusChip> : null}
      {mfaEnabled ? <StatusChip tone="good">2FA</StatusChip> : null}
      {canManage && active && !isSelf ? (
        <button type="button" className="btn tiny" disabled={pending} onClick={() => run(waiting ? 'invite' : 'reset')} title={waiting ? 'Send a fresh invite link' : 'Send a single-use link to choose a new password'}>
          {pending ? '…' : waiting ? 'Resend invite' : 'Reset link'}
        </button>
      ) : null}
      {result && !result.link ? (
        <span className="mono-sm" role="status">
          {result.message}
        </span>
      ) : null}
      {result?.link ? (
        <Modal title={waiting ? 'Invite link' : 'Password reset link'} sub={name} onClose={() => setResult(null)} maxWidth={560}>
          <InviteLink link={result.link} note={result.message} />
        </Modal>
      ) : null}
    </span>
  );
}
