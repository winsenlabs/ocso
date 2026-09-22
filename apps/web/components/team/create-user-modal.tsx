'use client';

import { useActionState, useEffect } from 'react';
import { CheckboxGroup, SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createUserAction } from '@/lib/actions/team';

export interface CreateUserModalProps {
  /** Roles this user may create (Tech Admin: all; CS Lead: CS Exec only). */
  roles: Array<{ value: string; label: string }>;
  teams: Array<{ value: string; label: string }>;
  onClose: () => void;
  onCreated: (message: string) => void;
}

const FORM_ID = 'create-user-form';

/** New user dialog → POST /v1/users. */
export function CreateUserModal({ roles, teams, onClose, onCreated }: CreateUserModalProps) {
  const [state, action, pending] = useActionState(createUserAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const execOnly = roles.length === 1 && roles[0]?.value === 'CS_EXEC';

  useEffect(() => {
    if (state.status === 'success') onCreated(state.message ?? 'User created');
  }, [state, onCreated]);

  return (
    <Modal
      title="New user"
      sub="gets access on first sign-in"
      onClose={onClose}
      maxWidth={560}
      footer={
        <>
          <span className="mono-sm">{execOnly ? 'CS Leads can create CS Exec accounts only' : 'role changes are audited'}</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Creating…' : 'Create user'}
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
        <TextField
          idPrefix="nu"
          name="password"
          label="Initial password"
          type="password"
          autoComplete="new-password"
          error={errors['password']}
          hint="at least 12 characters · share it securely; the user signs in with it"
          required
        />
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
