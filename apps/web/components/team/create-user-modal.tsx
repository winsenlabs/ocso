'use client';

import { useActionState, useEffect, useState } from 'react';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { CheckboxGroup, SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createUserAction, submitPendingUserAction, type InviteState } from '@/lib/actions/team';
import { InviteLink } from './invite-link';

export interface CreateUserModalProps {
  /** Roles this user may create (Tech admin: all; Lead: Service member only). */
  roles: Array<{ value: string; label: string }>;
  teams: Array<{ value: string; label: string }>;
  onClose: () => void;
  onCreated: (message: string) => void;
}

const FORM_ID = 'create-user-form';

const START: InviteState = IDLE;

/**
 * New user dialog → POST /v1/users (ADR-025, PM/research/11 §3.4): the user is created pending approval, then
 * the same dialog asks for a checker (never the maker, never the new user); on approval they become active and
 * the invite is sent. Cancelling the checker step leaves a pending draft (submit or discard it from the drawer).
 */
export function CreateUserModal({ roles, teams, onClose, onCreated }: CreateUserModalProps) {
  const [state, action, pending] = useActionState(createUserAction, START);
  const approval = useApprovalRequest();
  const [asked, setAsked] = useState<string | null>(null);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const execOnly = roles.length === 1 && roles[0]?.value === 'SERVICE';
  const pendingUser = state.status === 'success' ? state.pendingUser : undefined;
  const run = approval.run;

  // With the log email driver the link is shown here once, so the modal stays open until "Done".
  useEffect(() => {
    if (state.status === 'success' && !state.inviteLink && !state.pendingUser) onCreated(state.message ?? 'User invited');
  }, [state, onCreated]);

  // Created pending approval: ask for the checker right away.
  useEffect(() => {
    if (!pendingUser || asked === pendingUser.id) return;
    setAsked(pendingUser.id);
    run({ objectKind: 'user', objectId: pendingUser.id, title: `Create ${pendingUser.role} ${pendingUser.name}` }, (choice) => submitPendingUserAction(pendingUser.id, choice), { always: true });
  }, [pendingUser, asked, run]);

  // The checker step closed: sent (or bootstrapped), or cancelled (a pending draft remains).
  useEffect(() => {
    if (!pendingUser || asked !== pendingUser.id || approval.modal || approval.pending) return;
    onCreated(
      approval.outcome === 'proposed'
        ? `${pendingUser.name} is waiting for a checker: they can sign in, and get their invite, once approved`
        : approval.outcome === 'bootstrapped'
          ? `${pendingUser.name} approved (bootstrap) · the invite is on its way`
          : `${state.message ?? 'Created'} · not yet submitted: open them on the Team page to submit or discard`,
    );
  }, [pendingUser, asked, approval.modal, approval.pending, approval.outcome, state.message, onCreated]);

  if (pendingUser) return approval.modal;

  if (state.status === 'success' && state.inviteLink) {
    return (
      <Modal
        title="New user"
        sub={state.message}
        onClose={() => onCreated(state.message ?? 'User invited')}
        maxWidth={560}
        footer={
          <>
            <span className="sp" />
            <button type="button" className="btn accent" onClick={() => onCreated(state.message ?? 'User invited')}>
              Done
            </button>
          </>
        }
      >
        <InviteLink link={state.inviteLink} note="Email is not configured on this deployment, so no invite was sent. Copy this link and give it to the person privately — it lets them choose their password once." expiresAt={state.expiresAt} />
      </Modal>
    );
  }

  return (
    <Modal
      title="New user"
      sub="invited by email · chooses their own password"
      onClose={onClose}
      maxWidth={560}
      footer={
        <>
          <span className="mono-sm">{execOnly ? 'Leads can create Service member accounts only' : 'role changes are audited'}</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Inviting…' : 'Send invite'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} action={action} noValidate style={{ display: 'grid', gap: 14 }}>
        {state.message && state.status === 'error' ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {state.message}
          </AlertBanner>
        ) : null}
        <div className="fld-row">
          <TextField idPrefix="nu" name="name" label="Full name" autoComplete="off" defaultValue={values['name']} error={errors['name']} required />
          <TextField idPrefix="nu" name="email" label="Work email" type="email" autoComplete="off" defaultValue={values['email']} error={errors['email']} required />
        </div>
        <div className="fld-row">
          <SelectField idPrefix="nu" name="role" label="Role" options={roles} defaultValue={values['role'] || roles[0]?.value} error={errors['role']} />
          <TextField
            idPrefix="nu"
            name="maxConcurrent"
            label="Max concurrent conversations"
            type="number"
            min={1}
            max={50}
            defaultValue={values['maxConcurrent'] || '8'}
            error={errors['maxConcurrent']}
          />
        </div>
        <TextField idPrefix="nu" name="languages" label="Languages" defaultValue={values['languages']} error={errors['languages']} hint="comma-separated, e.g. en, mr, hi" />
        {teams.length ? (
          <CheckboxGroup idPrefix="nu" name="teamIds" label="Teams" options={teams} error={errors['teamIds']} />
        ) : (
          <span className="mono-sm">no teams yet · create one to route work to this user</span>
        )}
      </form>
    </Modal>
  );
}
