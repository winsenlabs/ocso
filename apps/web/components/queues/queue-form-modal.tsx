'use client';

import { useState, type FormEvent } from 'react';
import { CheckboxGroup, SelectField, TextField } from '@/components/forms/field';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import type { HoursForm } from '@/components/agents/lib/business-hours';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { saveQueueAction } from '@/lib/actions/queues';
import type { QueueFormFields } from './forms';
import { QueueHoursFields, QueueRoutingFields, hoursToForm, hoursToInput, type AttributeRow } from './queue-routing-fields';

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
  agentId: string | null;
  attributes: Record<string, string>;
  businessHours: { timezone: string; humanHours: Record<string, [string, string]> } | null;
  transferTargetIds: string[];
  /** Approved queues change only through proposals (PM/research/11 §4). */
  approved: boolean;
}

const FORM_ID = 'queue-form';

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

/**
 * New / edit queue dialog → POST /v1/queues (a draft) or PATCH /v1/queues/:id.
 * Once the queue is approved the save opens the submit-for-approval modal
 * (the API answers approval_required); removals of transfer targets and of
 * your own team apply at once.
 */
export function QueueFormModal({
  queue,
  teams,
  policies,
  agents,
  queues,
  onClose,
  onSaved,
}: {
  queue: QueueDraft | null;
  teams: Option[];
  policies: Option[];
  agents: Option[];
  queues: Option[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [mode, setMode] = useState(queue?.mode ?? 'OPEN_PICKUP');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attributes, setAttributes] = useState<AttributeRow[]>(Object.entries(queue?.attributes ?? {}).map(([key, value]) => ({ key, value })));
  const [hours, setHours] = useState<HoursForm | null>(queue?.businessHours ? hoursToForm(queue.businessHours) : null);
  const approval = useApprovalRequest();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const fields: QueueFormFields = {
      name: text(fd, 'name'),
      description: text(fd, 'description'),
      mode: text(fd, 'mode'),
      autoAssignAfterSeconds: text(fd, 'autoAssignAfterSeconds'),
      acceptTimeoutSeconds: text(fd, 'acceptTimeoutSeconds'),
      requiredSkills: text(fd, 'requiredSkills'),
      languages: text(fd, 'languages'),
      preferAccountOwner: fd.get('preferAccountOwner') !== null,
      slaPolicyId: text(fd, 'slaPolicyId'),
      teamIds: fd.getAll('teamIds').filter((v): v is string => typeof v === 'string'),
      agentId: text(fd, 'agentId'),
      attributes,
      businessHours: hours ? hoursToInput(hours) : null,
      transferTargetIds: fd.getAll('transferTargetIds').filter((v): v is string => typeof v === 'string'),
    };
    const name = fields.name.trim() || 'queue';
    approval.run({ objectKind: 'queue', objectId: queue?.id ?? '', title: `Change queue ${queue?.name ?? name}` }, async (choice) => {
      // What the dialog showed: removals are only what was unticked here, never what someone added since.
      const baseline = queue ? { teamIds: queue.teamIds, transferTargetIds: queue.transferTargetIds } : undefined;
      const r = await saveQueueAction(queue?.id ?? null, fields, choice, baseline);
      setErrors(!r.ok && r.fieldErrors ? r.fieldErrors : {});
      if (r.ok) onSaved(r.data.proposed ? `Sent “${r.data.proposed.title}” for approval` : queue ? `Saved queue ${name}` : `Created queue ${name} (a draft: submit it for approval before routers use it)`);
      return r;
    });
  }

  const others = queues.filter((q) => q.value !== queue?.id);
  return (
    <Modal
      title={queue ? `Edit ${queue.name}` : 'New queue'}
      sub={queue?.approved ? 'approved · changes need a checker' : 'a draft until approved · routers cannot use it yet'}
      onClose={onClose}
      maxWidth={680}
      footer={
        <>
          <span className="mono-sm">{queue?.approved ? 'nothing changes until the checker approves' : 'applies to new handoffs'}</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={approval.pending}>
            {approval.pending ? 'Saving…' : queue ? (queue.approved ? 'Submit change' : 'Save queue') : 'Create queue'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate style={{ display: 'grid', gap: 14 }}>
        {approval.error || errors['form'] ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {approval.error ?? errors['form']}
          </AlertBanner>
        ) : null}
        <div className="fld-row">
          <TextField idPrefix="q" name="name" label="Queue name" defaultValue={queue?.name ?? ''} error={errors['name']} required />
          <TextField idPrefix="q" name="description" label="Description" defaultValue={queue?.description ?? ''} error={errors['description']} hint="optional" />
        </div>
        <QueueRoutingFields agents={agents} agentId={queue?.agentId ?? ''} attributes={attributes} onAttributes={setAttributes} targets={others} targetIds={queue?.transferTargetIds ?? []} error={errors['attributes']} />
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="q-mode">Pickup mode</label>
            <select id="q-mode" name="mode" value={mode} onChange={(e) => setMode(e.target.value as QueueDraft['mode'])}>
              <option value="OPEN_PICKUP">Open pickup — eligible execs claim</option>
              <option value="AUTO_ASSIGN">Auto-assign — least active eligible exec</option>
            </select>
          </div>
          {mode === 'OPEN_PICKUP' ? <input type="hidden" name="acceptTimeoutSeconds" value={String(queue?.acceptTimeoutSeconds ?? 120)} /> : null}
          {mode === 'OPEN_PICKUP' ? (
            <TextField key="auto" idPrefix="q" name="autoAssignAfterSeconds" type="number" min={10} label="Auto-assign after (seconds)" defaultValue={queue?.autoAssignAfterSeconds?.toString() ?? ''} error={errors['autoAssignAfterSeconds']} hint="blank = stays in pickup until claimed" />
          ) : (
            <TextField key="accept" idPrefix="q" name="acceptTimeoutSeconds" type="number" min={15} label="Accept within (seconds)" defaultValue={String(queue?.acceptTimeoutSeconds ?? 120)} error={errors['acceptTimeoutSeconds']} hint="then offered to the next exec" />
          )}
        </div>
        {teams.length ? (
          <CheckboxGroup idPrefix="q" name="teamIds" label="Eligible teams" options={teams} defaultValues={queue?.teamIds ?? []} error={errors['teamIds']} hint="execs in these teams can pick up or be assigned" />
        ) : (
          <p className="mono-sm" style={{ margin: 0 }}>
            No teams yet — create teams under Team to make execs eligible for this queue.
          </p>
        )}
        <QueueHoursFields hours={hours} onHours={setHours} />
        <div className="fld-row">
          <TextField idPrefix="q" name="requiredSkills" label="Required skills" defaultValue={queue?.requiredSkills.join(', ') ?? ''} error={errors['requiredSkills']} hint="comma separated, e.g. cards, disputes" />
          <TextField idPrefix="q" name="languages" label="Languages" defaultValue={queue?.languages.join(', ') ?? ''} error={errors['languages']} hint="comma separated codes, e.g. en, hi, mr" />
        </div>
        <div className="fld-row">
          <SelectField idPrefix="q" name="slaPolicyId" label="SLA policy" options={[{ value: '', label: 'No SLA policy' }, ...policies]} defaultValue={queue?.slaPolicyId ?? ''} error={errors['slaPolicyId']} hint="sets the pickup clock on handoffs" />
          <label className="toggle-row" style={{ alignSelf: 'center' }}>
            <input type="checkbox" name="preferAccountOwner" defaultChecked={queue?.preferAccountOwner ?? true} />
            Prefer the customer&apos;s account owner
          </label>
        </div>
      </form>
      {approval.modal}
    </Modal>
  );
}
