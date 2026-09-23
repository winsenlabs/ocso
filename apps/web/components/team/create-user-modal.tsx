'use client';

import { useActionState, useEffect } from 'react';
import { CheckboxGroup, SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createUserAction, type InviteState } from '@/lib/actions/team';
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

/** New user dialog → POST /v1/users: sends an invite; the user chooses their own password (ADR-025). */
export function CreateUserModal({ roles, teams, onClose, onCreated }: CreateUserModalProps) {
  const [state, action, pending] = useActionState(createUserAction, START);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const execOnly = roles.length === 1 && roles[0]?.value === 'SERVICE';

  // With the log email driver the link is shown here once, so the modal stays open until "Done".
  useEffect(() => {
    if (state.status === 'success' && !state.inviteLink) onCreated(state.message ?? 'User invited');
  }, [state, onCreated]);

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
