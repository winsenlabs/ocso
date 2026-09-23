'use client';

import { useActionState, useEffect } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createTeamAction } from '@/lib/actions/team';

const FORM_ID = 'create-team-form';

/** New team dialog → POST /v1/teams. */
export function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const [state, action, pending] = useActionState(createTeamAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};

  useEffect(() => {
    if (state.status === 'success') onCreated(state.message ?? 'Team created');
  }, [state, onCreated]);

  return (
    <Modal
      title="New team"
      sub="teams drive routing and visibility"
      onClose={onClose}
      maxWidth={480}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Creating…' : 'Create team'}
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
        <TextField idPrefix="nt" name="name" label="Team name" defaultValue={values['name']} error={errors['name']} required />
        <TextField idPrefix="nt" name="description" label="Description" defaultValue={values['description']} error={errors['description']} hint="optional" />
      </form>
    </Modal>
  );
}
