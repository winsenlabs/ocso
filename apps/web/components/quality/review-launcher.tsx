'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { IDLE } from '@/lib/actions/form-state';
import { createReviewAction } from '@/lib/actions/quality';
import { RUBRIC_KEYS, rubricPreview, type RubricKey } from './forms';

export interface RubricView {
  criteria: Record<string, string>;
  scale: { min: number; max: number };
  outcomeTags: string[];
  scoreDefinition: string;
}

const FORM_ID = 'review-form';

function Criterion({ k, text, scale, value, onChange, error }: { k: RubricKey; text: string; scale: { min: number; max: number }; value: number | undefined; onChange: (n: number) => void; error: string | undefined }) {
  const options = Array.from({ length: scale.max - scale.min + 1 }, (_, i) => scale.min + i);
  return (
    <fieldset className="ops-crit" aria-describedby={`crit-${k}-d${error ? ` crit-${k}-e` : ''}`}>
      <legend>{k}</legend>
      <span id={`crit-${k}-d`} className="mono-sm">
        {text}
      </span>
      <div className="ops-scale">
        {options.map((n) => (
          <label key={n} className={value === n ? 'on' : undefined}>
            <input type="radio" name={k} value={n} checked={value === n} onChange={() => onChange(n)} />
            {n}
          </label>
        ))}
      </div>
      {error ? (
        <span id={`crit-${k}-e`} className="err" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

/** "Review" button + rubric dialog → POST /v1/reviews (explicit 4-criterion rubric, no opaque score). */
export function ReviewLauncher({ conversation, rubric, openInitially = false, closeHref, buttonClass = 'btn tiny' }: { conversation: { id: string; displayId: string; label: string }; rubric: RubricView; openInitially?: boolean; closeHref?: string; buttonClass?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(openInitially);
  const [scores, setScores] = useState<Partial<Record<RubricKey, number>>>({});
  const [done, setDone] = useState<string | null>(null);
  const [state, action, pending] = useActionState(createReviewAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const preview = rubricPreview(scores);

  useEffect(() => {
    if (state.status !== 'success') return;
    setOpen(false);
    setDone(state.message ?? 'Reviewed');
    if (closeHref) router.replace(closeHref, { scroll: false });
  }, [state, closeHref, router]);

  const close = () => {
    setOpen(false);
    if (closeHref && openInitially) router.replace(closeHref, { scroll: false });
  };

  return (
    <>
      {done ? (
        <span className="mono-sm" role="status">
          {done}
        </span>
      ) : (
        <button type="button" className={buttonClass} onClick={() => setOpen(true)} aria-label={`Review ${conversation.label}`}>
          Review
        </button>
      )}
      {open ? (
        <Modal
          title={`Review ${conversation.label}`}
          sub={conversation.label === conversation.displayId ? 'scored 1–5 per criterion' : conversation.displayId}
          onClose={close}
          maxWidth={600}
          footer={
            <>
              <span className="mono-sm" title={rubric.scoreDefinition}>
                score {preview === null ? '—' : preview.toFixed(2)} · mean of the four criteria
              </span>
              <span className="sp" />
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
                {pending ? 'Saving…' : 'Submit review'}
              </button>
            </>
          }
        >
          <form id={FORM_ID} action={action} noValidate style={{ display: 'grid', gap: 12 }}>
            {state.status === 'error' && state.message ? (
              <AlertBanner tone="error" style={{ margin: 0 }}>
                {state.message}
              </AlertBanner>
            ) : null}
            <input type="hidden" name="conversationId" value={conversation.id} />
            {RUBRIC_KEYS.map((k) => (
              <Criterion key={k} k={k} text={rubric.criteria[k] ?? ''} scale={rubric.scale} value={scores[k]} onChange={(n) => setScores((s) => ({ ...s, [k]: n }))} error={errors[k]} />
            ))}
            <div className="fld">
              <label htmlFor="rv-outcomeTag">Outcome</label>
              <input id="rv-outcomeTag" name="outcomeTag" list="rv-outcomes" defaultValue={state.values?.['outcomeTag']} aria-invalid={errors['outcomeTag'] ? true : undefined} placeholder="e.g. good handoff" />
              <datalist id="rv-outcomes">
                {rubric.outcomeTags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {errors['outcomeTag'] ? (
                <span className="err" role="alert">
                  {errors['outcomeTag']}
                </span>
              ) : (
                <span className="hint">suggested tags or your own words</span>
              )}
            </div>
            <div className="fld">
              <label htmlFor="rv-notes">Notes</label>
              <textarea id="rv-notes" name="notes" rows={3} defaultValue={state.values?.['notes']} placeholder="optional · what to keep, what to fix" />
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
