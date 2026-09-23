'use client';

import { useState, type FormEvent } from 'react';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { saveSlaPolicyAction } from '@/lib/actions/queues';
import { CONVERSATION_TYPES, PRIORITY_KEYS, toHours, toMinutes, type SlaFormFields } from './forms';

/** Client-safe SLA policy shape (lib/api/queues SlaPolicy). */
export interface SlaDraft {
  id: string;
  name: string;
  firstHumanResponseSeconds: number;
  pickupSecondsByPriority: Partial<Record<(typeof PRIORITY_KEYS)[number], number>>;
  resolutionSecondsByType: Record<string, number>;
  atRiskFraction: number;
  /** Approved policies change only through proposals (PM/research/11 §4). */
  approved: boolean;
}

const val = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

const FORM_ID = 'sla-form';

/**
 * New / edit SLA policy → POST /v1/sla-policies (a draft) or PUT /v1/sla-policies/:id. Minutes and hours in,
 * seconds out. Once the policy is approved, saving opens the submit-for-approval modal.
 */
export function SlaFormModal({ policy, onClose, onSaved }: { policy: SlaDraft | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const approval = useApprovalRequest();
  const pending = approval.pending;
  const initial = (_key: string, fallback: string) => fallback;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const fields: SlaFormFields = {
      name: val(fd, 'name'),
      firstHumanResponse: val(fd, 'firstHumanResponse'),
      atRiskPercent: val(fd, 'atRiskPercent'),
      pickup: Object.fromEntries(PRIORITY_KEYS.map((k) => [k, val(fd, `pickup${k}`)])),
      resolution: Object.fromEntries(CONVERSATION_TYPES.map((t) => [t, val(fd, `resolution${t}`)])),
    };
    approval.run({ objectKind: 'sla_policy', objectId: policy?.id ?? '', title: `Change SLA policy ${policy?.name ?? fields.name}` }, async (choice) => {
      const r = await saveSlaPolicyAction(policy?.id ?? null, fields, choice);
      setErrors(!r.ok && r.fieldErrors ? r.fieldErrors : {});
      if (r.ok) onSaved(r.data.proposed ? `Sent “${r.data.proposed.title}” for approval` : policy ? `Saved SLA policy ${fields.name}` : `Created SLA policy ${fields.name} (a draft: submit it for approval)`);
      return r;
    });
  }

  return (
    <Modal
      title={policy ? `Edit ${policy.name}` : 'New SLA policy'}
      sub="attach it to queues to start the clock"
      onClose={onClose}
      maxWidth={640}
      footer={
        <>
          <span className="mono-sm">applies to handoffs routed after saving</span>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Saving…' : policy ? (policy.approved ? 'Submit change' : 'Save policy') : 'Create policy'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate style={{ display: 'grid', gap: 14 }}>
        {approval.error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {approval.error}
          </AlertBanner>
        ) : null}
        <div className="fld-row">
          <TextField idPrefix="sla" name="name" label="Policy name" defaultValue={initial('name', policy?.name ?? '')} error={errors['name']} required />
          <TextField idPrefix="sla" name="firstHumanResponse" type="number" min={0.5} label="First human response (minutes)" defaultValue={initial('firstHumanResponse', toMinutes(policy?.firstHumanResponseSeconds ?? 900))} error={errors['firstHumanResponse']} hint="pickup target when a priority has none" required />
        </div>
        <fieldset className="ops-fieldset">
          <legend>Pickup target by priority (minutes)</legend>
          <div className="ops-grid4">
            {PRIORITY_KEYS.map((p) => (
              <TextField key={p} idPrefix="sla" name={`pickup${p}`} type="number" min={0.5} label={p} defaultValue={initial(`pickup${p}`, toMinutes(policy?.pickupSecondsByPriority[p]))} error={errors[`pickup${p}`]} placeholder="first response" />
            ))}
          </div>
        </fieldset>
        <fieldset className="ops-fieldset">
          <legend>Resolution target by conversation type (hours)</legend>
          <div className="ops-grid5">
            {CONVERSATION_TYPES.map((t) => (
              <TextField key={t} idPrefix="sla" name={`resolution${t}`} type="number" min={0.02} label={t.toLowerCase()} defaultValue={initial(`resolution${t}`, toHours(policy?.resolutionSecondsByType[t]))} error={errors[`resolution${t}`]} placeholder="none" />
            ))}
          </div>
        </fieldset>
        <TextField idPrefix="sla" name="atRiskPercent" type="number" min={10} max={99} label="At risk after (% of the window)" defaultValue={initial('atRiskPercent', String(Math.round((policy?.atRiskFraction ?? 0.75) * 100)))} error={errors['atRiskPercent']} hint="timers turn amber here" />
      </form>
      {approval.modal}
    </Modal>
  );
}
