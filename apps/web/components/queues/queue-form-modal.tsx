'use client';

import { useActionState, useEffect, useState } from 'react';
import { CheckboxGroup, SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { saveQueueAction } from '@/lib/actions/queues';

export interface Option {
  value: string;
  label: string;
}

/** The editable part of a queue (client-safe subset of lib/api/queues Queue). */
export interface QueueDraft {
  id: string;
  name: string;
  description: string | null;
  mode: 'OPEN_PICKUP' | 'AUTO_ASSIGN';
  autoAssignAfterSeconds: number | null;
  acceptTimeoutSeconds: number;
  requiredSkills: string[];
  languages: string[];
  preferAccountOwner: boolean;
  slaPolicyId: string | null;
  teamIds: string[];
}

const FORM_ID = 'queue-form';

/** New / edit queue dialog → POST /v1/queues or PATCH /v1/queues/:id. */
export function QueueFormModal({ queue, teams, policies, onClose, onSaved }: { queue: QueueDraft | null; teams: Option[]; policies: Option[]; onClose: () => void; onSaved: (message: string) => void }) {
  const [state, action, pending] = useActionState(saveQueueAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const initial = (key: string, fallback: string) => (v ? (v[key] ?? '') : fallback);
  const [mode, setMode] = useState(initial('mode', queue?.mode ?? 'OPEN_PICKUP'));

  useEffect(() => {
    if (state.status === 'success') onSaved(state.message ?? 'Queue saved');
  }, [state, onSaved]);

  const teamDefaults = v ? (v['teamIds'] ?? '').split(',').filter(Boolean) : (queue?.teamIds ?? []);
  const preferOwner = v ? v['preferAccountOwner'] === 'on' : (queue?.preferAccountOwner ?? true);

  return (
    <Modal
      title={queue ? `Edit ${queue.name}` : 'New queue'}
      sub="routing changes are audited"
      onClose={onClose}
      maxWidth={640}
      footer={
        <>
          <span className="mono-sm">applies to new handoffs</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Saving…' : queue ? 'Save queue' : 'Create queue'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} action={action} noValidate style={{ display: 'grid', gap: 14 }}>
        {state.status === 'error' && state.message ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {state.message}
          </AlertBanner>
        ) : null}
        {queue ? <input type="hidden" name="id" value={queue.id} /> : null}
        <div className="fld-row">
          <TextField idPrefix="q" name="name" label="Queue name" defaultValue={initial('name', queue?.name ?? '')} error={errors['name']} required />
          <TextField idPrefix="q" name="description" label="Description" defaultValue={initial('description', queue?.description ?? '')} error={errors['description']} hint="optional" />
        </div>
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="q-mode">Routing mode</label>
            <select id="q-mode" name="mode" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="OPEN_PICKUP">Open pickup — eligible execs claim</option>
              <option value="AUTO_ASSIGN">Auto-assign — least active eligible exec</option>
            </select>
          </div>
          {mode === 'OPEN_PICKUP' ? <input type="hidden" name="acceptTimeoutSeconds" value={String(queue?.acceptTimeoutSeconds ?? 120)} /> : null}
          {mode === 'OPEN_PICKUP' ? (
            <TextField key="auto" idPrefix="q" name="autoAssignAfterSeconds" type="number" min={10} label="Auto-assign after (seconds)" defaultValue={initial('autoAssignAfterSeconds', queue?.autoAssignAfterSeconds?.toString() ?? '')} error={errors['autoAssignAfterSeconds']} hint="blank = stays in pickup until claimed" />
          ) : (
            <TextField key="accept" idPrefix="q" name="acceptTimeoutSeconds" type="number" min={15} label="Accept within (seconds)" defaultValue={initial('acceptTimeoutSeconds', String(queue?.acceptTimeoutSeconds ?? 120))} error={errors['acceptTimeoutSeconds']} hint="then offered to the next exec" />
          )}
        </div>
        {teams.length ? (
          <CheckboxGroup idPrefix="q" name="teamIds" label="Eligible teams" options={teams} defaultValues={teamDefaults} error={errors['teamIds']} hint="execs in these teams can pick up or be assigned" />
        ) : (
          <p className="mono-sm" style={{ margin: 0 }}>
            No teams yet — create teams under Team to make execs eligible for this queue.
          </p>
        )}
        <div className="fld-row">
          <TextField idPrefix="q" name="requiredSkills" label="Required skills" defaultValue={initial('requiredSkills', queue?.requiredSkills.join(', ') ?? '')} error={errors['requiredSkills']} hint="comma separated, e.g. cards, disputes" />
          <TextField idPrefix="q" name="languages" label="Languages" defaultValue={initial('languages', queue?.languages.join(', ') ?? '')} error={errors['languages']} hint="comma separated codes, e.g. en, hi, mr" />
        </div>
        <div className="fld-row">
          <SelectField idPrefix="q" name="slaPolicyId" label="SLA policy" options={[{ value: '', label: 'No SLA policy' }, ...policies]} defaultValue={initial('slaPolicyId', queue?.slaPolicyId ?? '')} error={errors['slaPolicyId']} hint="sets the pickup clock on handoffs" />
          <label className="toggle-row" style={{ alignSelf: 'center' }}>
            <input type="checkbox" name="preferAccountOwner" defaultChecked={preferOwner} />
            Prefer the customer&apos;s account owner
          </label>
        </div>
      </form>
    </Modal>
  );
}
