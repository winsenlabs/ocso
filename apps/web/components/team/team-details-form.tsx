'use client';

import { useActionState, useEffect, useState } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateTeamAction } from '@/lib/actions/team-membership';

/** Rename / describe a team (PATCH /v1/teams/:id): CS Leads, on teams they belong to. */
export function TeamDetailsForm({ id, name, description }: { id: string; name: string; description: string | null }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateTeamAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const values = state.status === 'error' ? (state.values ?? {}) : {};

  useEffect(() => {
    if (state.status === 'success') setEditing(false);
  }, [state]);

  if (!editing) {
    return (
      <div className="rowsplit">
        <span className="mono-sm" role="status">
          {state.status === 'success' ? state.message : null}
        </span>
        <span className="sp" />
        <button type="button" className="btn tiny" onClick={() => setEditing(true)}>
          Rename or describe
        </button>
      </div>
    );
  }

  return (
    <form action={action} aria-label="Team details" noValidate style={{ display: 'grid', gap: 10 }}>
      {state.status === 'error' && state.message ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <input type="hidden" name="id" value={id} />
      <TextField idPrefix="td" name="name" label="Team name" defaultValue={values['name'] ?? name} error={errors['name']} required />
      <TextField idPrefix="td" name="description" label="Description" defaultValue={values['description'] ?? description ?? ''} error={errors['description']} hint="optional" />
      <div className="rowsplit">
        <span className="sp" />
        <button type="button" className="btn" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Saving…' : 'Save team'}
        </button>
      </div>
    </form>
  );
}
