'use client';

import { ApprovableButton } from '@/components/approvals/approvable-button';
import { submitPendingUserAction } from '@/lib/actions/team';

/**
 * Submit a pending user's creation to a checker (PM/research/11 §3.4): the
 * checker holds approvals.check.permissions and is never you nor the new user;
 * approval activates them and sends the invite.
 */
export function SubmitPendingUser({ userId, name, role }: { userId: string; name: string; role: string }) {
  return (
    <ApprovableButton
      always
      label="Submit for approval"
      ariaLabel={`Submit ${name} for approval`}
      buttonClass="btn tiny accent"
      title={`Create ${role} ${name}`}
      confirmLabel="Submit"
      target={{ objectKind: 'user', objectId: userId, title: `Create ${role} ${name}` }}
      write={(choice) => submitPendingUserAction(userId, choice)}
    >
      A checker approves the new account; they can sign in, and get their invite, once approved.
    </ApprovableButton>
  );
}
