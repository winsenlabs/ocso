'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createCorrectionAction } from '@/lib/actions/quality';
import { COMPONENTS, COMPONENT_LABELS } from './forms';

export interface CorrectionSource {
  conversationId: string;
  displayId: string;
  /** The turn (interaction seq) the problem was observed at, when known. */
  seq: number | null;
}

const FORM_ID = 'new-correction-form';

function Area({ name, label, value, error, rows = 3, hint }: { name: string; label: string; value: string | undefined; error: string | undefined; rows?: number; hint?: string }) {
  const id = `nc-${name}`;
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name={name} rows={rows} defaultValue={value} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} />
      {hint ? (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** "New correction" → POST /v1/corrections. Opened from the page head, or from a conversation link (`?new=1&conversation=…&seq=…`). */
export function NewCorrection({ agents, source, openInitially, closeHref }: { agents: Array<{ value: string; label: string }>; source: CorrectionSource | null; openInitially: boolean; closeHref: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(openInitially);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, action, pending] = useActionState(createCorrectionAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};

  useEffect(() => {
    if (state.status !== 'success') return;
    setOpen(false);
    setNotice(state.message ?? 'Correction recorded');
    if (openInitially) router.replace(closeHref, { scroll: false });
  }, [state, openInitially, closeHref, router]);

  const close = () => {
    setOpen(false);
    if (openInitially) router.replace(closeHref, { scroll: false });
  };

  return (
    <>
      <span className="mono-sm" role="status" aria-live="polite" style={{ alignSelf: 'center' }}>
        {notice}
      </span>
      <button type="button" className="btn accent" onClick={() => setOpen(true)} disabled={!agents.length && !source}>
        New correction
      </button>
      {open ? (
        <Modal
          title="New prompt correction"
          sub={source ? `from ${source.displayId}${source.seq ? ` · turn ${source.seq}` : ''}` : 'recorded in the audit log'}
          onClose={close}
          maxWidth={640}
          footer={
            <>
              <span className="mono-sm">staging into a draft is a separate, audited step</span>
              <span className="sp" />
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
                {pending ? 'Saving…' : 'Record correction'}
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
            {source ? (
              <>
                <input type="hidden" name="conversationId" value={source.conversationId} />
                {source.seq ? <input type="hidden" name="interactionSeq" value={String(source.seq)} /> : null}
                {errors['conversationId'] || errors['interactionSeq'] ? (
                  <AlertBanner tone="error" style={{ margin: 0 }}>
                    {errors['conversationId'] ?? errors['interactionSeq']}
                  </AlertBanner>
                ) : null}
              </>
            ) : null}
            <div className="fld-row">
              {source ? (
                <p className="mono-sm" style={{ margin: 0, alignSelf: 'end' }}>
                  agent: the conversation&apos;s virtual agent
                </p>
              ) : (
                <SelectField idPrefix="nc" name="agentId" label="Virtual agent" options={[{ value: '', label: 'Choose an agent' }, ...agents]} defaultValue={v['agentId'] ?? ''} error={errors['agentId']} />
              )}
              <SelectField idPrefix="nc" name="componentKey" label="Prompt component" options={[{ value: '', label: 'Choose a component' }, ...COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABELS[c] ?? c }))]} defaultValue={v['componentKey'] ?? ''} error={errors['componentKey']} />
            </div>
            <TextField idPrefix="nc" name="title" label="Title" defaultValue={v['title']} error={errors['title']} hint="optional · defaults to the desired behaviour · same title merges" />
            <Area name="observed" label="Observed problem" value={v['observed']} error={errors['observed']} />
            <Area name="desired" label="Desired behaviour" value={v['desired']} error={errors['desired']} />
            <Area name="proposedText" label="Proposed prompt text" value={v['proposedText']} error={errors['proposedText']} rows={3} hint="optional · the line to add to the component when staged" />
          </form>
        </Modal>
      ) : null}
    </>
  );
}
