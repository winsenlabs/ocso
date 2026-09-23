'use client';

import { useActionState } from 'react';
import { SettingsApprovalFields } from './approval-fields';
import { SelectField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateAssistantAction } from '@/lib/actions/governance';

/**
 * Model profile and the writes switch for Ask OCSO, the internal agent (PM/research/12). Every write Ask OCSO
 * proposes is a card the user confirms; turning writes off stops even that, and reads keep working.
 */
export function AssistantForm({ profiles, profileId, writesEnabled }: { profiles: Array<{ id: string; name: string }>; profileId: string | null; writesEnabled: boolean }) {
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
      <input type="hidden" name="askOcsoWritesBefore" value={String(writesEnabled)} />
      <label className="toggle-row">
        <input type="checkbox" name="askOcsoWrites" defaultChecked={writesEnabled} aria-describedby="assistant-writes-hint" />
        Let Ask OCSO propose changes
      </label>
      <span id="assistant-writes-hint" className="mono-sm">
        Each change still waits for the person&apos;s click on a card, and changes that need approval go to a checker. Off: Ask OCSO only answers questions.
      </span>
      <SettingsApprovalFields idPrefix="assistant" errors={state.fieldErrors} />
      <div className="rowsplit">
        <button type="submit" className="btn accent" disabled={pending}>
          {pending ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </form>
  );
}
