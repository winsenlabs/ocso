'use client';

import { useActionState } from 'react';
import { SettingsApprovalFields } from './approval-fields';
import { SelectField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateAssistantAction } from '@/lib/actions/governance';

/** Model profile and confirmation policy for Ask OCSO, the internal agent (docs/12). */
export function AssistantForm({ profiles, profileId, confirmLowWrites }: { profiles: Array<{ id: string; name: string }>; profileId: string | null; confirmLowWrites: boolean }) {
  const [state, action, pending] = useActionState(updateAssistantAction, IDLE);
  return (
    <form action={action} noValidate className="ch" style={{ gap: 12 }} aria-label="Ask OCSO">
      {state.message ? (
        <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <SelectField
        name="internalAgentProfileId"
        label="Model profile"
        defaultValue={profileId ?? ''}
        options={[{ value: '', label: 'Not set — Ask OCSO is off' }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
        hint="Ask OCSO answers with this logical model profile; its fallback and caching rules apply."
      />
      <label className="toggle-row">
        <input type="checkbox" name="internalAgentConfirmLowWrites" defaultChecked={confirmLowWrites} />
        Also require confirmation for low-risk changes (sensitive changes always require it)
      </label>
      <SettingsApprovalFields idPrefix="assistant" errors={state.fieldErrors} />
      <div className="rowsplit">
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </form>
  );
}
