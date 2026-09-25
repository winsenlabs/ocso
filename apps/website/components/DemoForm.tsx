'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { allFields, demoForm as def, validate } from '@/content/forms';
import { ChoiceField, FieldInput, MultiField } from './FormFields';

type Values = Record<string, string | string[]>;
type Status = 'idle' | 'sending' | 'done';

// Unsent answers (and the mobile step) stay in this browser's localStorage, so a reload or a closed tab loses
// nothing. Cleared once the request is sent.
const DRAFT_KEY = 'ocso-demo-request-draft';
type Draft = { values: Values; step: number };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<Draft>) : {};
    return { values: d.values && typeof d.values === 'object' ? d.values : {}, step: typeof d.step === 'number' ? d.step : 0 };
  } catch {
    return { values: {}, step: 0 };
  }
}

function saveDraft(draft: Draft | null) {
  try {
    if (draft) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* private window or storage blocked: the form still works */
  }
}

/** Below the lg breakpoint the form is stepped; from lg up it is one landscape page of three columns. */
const STEPPED_QUERY = '(max-width: 1023px)';
const subscribeStepped = (cb: () => void) => {
  const mq = window.matchMedia(STEPPED_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
const useStepped = () => useSyncExternalStore(subscribeStepped, () => window.matchMedia(STEPPED_QUERY).matches, () => false);

const noop = () => () => {};
/** False during server rendering, true in the browser: lets the form read its draft on first render. */
const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

function Form() {
  const stepped = useStepped();
  const [initial] = useState(loadDraft);
  const [values, setValues] = useState<Values>(initial.values);
  const [step, setStep] = useState(() => Math.min(Math.max(initial.step, 0), def.steps.length - 1));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>('idle');
  const [serverError, setServerError] = useState('');
  const [trap, setTrap] = useState('');
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const hasDraft = Object.values(values).some((v) => (Array.isArray(v) ? v.length : v));
  const last = step === def.steps.length - 1;

  useEffect(() => {
    if (status !== 'done') saveDraft(hasDraft || step ? { values, step } : null);
  }, [values, step, hasDraft, status]);

  // After Next or Back (not on first render), move focus to the new step's heading.
  useEffect(() => {
    if (moved.current) stepHeading.current?.focus();
  }, [step]);

  const goTo = (n: number) => {
    moved.current = true;
    setStep(n);
  };

  const set = (name: string, v: string | string[]) => {
    setValues((s) => ({ ...s, [name]: v }));
    if (errors[name])
      setErrors((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
  };

  const focusFirst = (errs: Record<string, string>) => {
    const first = allFields(def).find((f) => errs[f.name]);
    if (first) requestAnimationFrame(() => document.getElementById(`f-${first.name}`)?.focus());
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setServerError('');
    const check = validate(stepped ? def.steps[step]!.fields : allFields(def), values);
    if (Object.keys(check).length) {
      setErrors(check);
      focusFirst(check);
      return;
    }
    if (stepped && !last) {
      goTo(step + 1);
      return;
    }
    // On the last mobile step, the earlier steps are checked again (a draft may predate a rule change).
    const all = validate(allFields(def), values);
    if (Object.keys(all).length) {
      setErrors(all);
      const bad = def.steps.findIndex((s) => s.fields.some((f) => all[f.name]));
      if (stepped && bad >= 0 && bad !== step) goTo(bad);
      else focusFirst(all);
      return;
    }
    setStatus('sending');
    try {
      const res = await fetch(def.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, company_fax: trap, source_page: window.location.pathname }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        if (body.errors) {
          setErrors(body.errors);
          const bad = def.steps.findIndex((s) => s.fields.some((f) => body.errors?.[f.name]));
          if (stepped && bad >= 0) goTo(bad);
        }
        setServerError(body.error ?? 'Something went wrong. Please try again.');
        setStatus('idle');
        return;
      }
      saveDraft(null);
      setStatus('done');
    } catch {
      setServerError('You seem to be offline. Please try again.');
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <div role="status" className="flex flex-col items-start py-6">
        <span className="grid size-12 place-items-center rounded-full bg-accent/20 text-xl text-accent">✓</span>
        <p className="mt-6 text-2xl font-medium text-fg">{def.successTitle}</p>
        <p className="mt-3 max-w-md text-fg/65">{def.successBody}</p>
      </div>
    );
  }

  const visible = stepped ? [def.steps[step]!] : def.steps;
  const note = 'Your answers are kept on this device until you send them. We use these details only to reply to you. No cookies, no analytics.';
  return (
    <form onSubmit={submit} noValidate aria-label={def.title} className="relative flex flex-col">
      {stepped && (
        <div className="mb-7">
          <div className="flex gap-1.5" aria-hidden>
            {def.steps.map((s, i) => (
              <span key={s.title} className={`h-1 flex-1 rounded-full transition ${i <= step ? 'bg-accent' : 'bg-fg/12'}`} />
            ))}
          </div>
          <p aria-live="polite" className="mt-4 font-mono text-xs uppercase tracking-[0.2em] text-accent">
            Step {step + 1} of {def.steps.length}
            <span className="sr-only">: {def.steps[step]!.title}</span>
          </p>
        </div>
      )}
      <div className={stepped ? '' : 'grid grid-cols-3 divide-x divide-fg/10'}>
        {visible.map((s) => {
          const n = def.steps.indexOf(s);
          return (
            <section key={s.title} aria-labelledby={`step-${n}`} className={stepped ? undefined : 'min-w-0 px-7 first:pl-0 last:pr-0'}>
              <h3
                id={`step-${n}`}
                ref={stepped ? stepHeading : undefined}
                tabIndex={stepped ? -1 : undefined}
                className={stepped ? 'mb-6 text-2xl font-medium text-fg outline-none' : 'mb-5 flex items-center gap-3 text-base font-medium text-fg'}
              >
                {!stepped && <span className="grid size-6 place-items-center rounded-full bg-accent/15 font-mono text-xs text-accent">{n + 1}</span>}
                {s.title}
              </h3>
              <div className="grid gap-5">
                {s.fields.map((f) => (
                  <div key={f.name}>
                    {f.type === 'multi' ? (
                      <MultiField field={f} value={Array.isArray(values[f.name]) ? (values[f.name] as string[]) : []} error={errors[f.name]} onChange={(v) => set(f.name, v)} />
                    ) : f.type === 'choice' ? (
                      <ChoiceField field={f} value={(values[f.name] as string) ?? ''} error={errors[f.name]} onChange={(v) => set(f.name, v)} />
                    ) : (
                      <FieldInput field={f} value={(values[f.name] as string) ?? ''} error={errors[f.name]} onChange={(v) => set(f.name, v)} />
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {/* Honeypot: hidden from people, filled by bots. */}
      <input tabIndex={-1} autoComplete="off" aria-hidden name="company_fax" value={trap} onChange={(e) => setTrap(e.target.value)} className="absolute -left-[9999px] h-0 w-0 opacity-0" />
      {serverError && (
        <p role="alert" className="mt-6 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {serverError}
        </p>
      )}
      {stepped ? (
        <>
          <div className="mt-8 flex items-center gap-3">
            {step > 0 && (
              <button type="button" onClick={() => goTo(step - 1)} aria-label={`Back to step ${step}: ${def.steps[step - 1]!.title}`} className="rounded-2xl border border-fg/15 px-5 py-4 font-medium text-fg/80 hover:bg-fg/10">
                Back
              </button>
            )}
            <button type="submit" disabled={status === 'sending'} className="flex-1 rounded-2xl bg-fg px-6 py-4 font-medium text-bg transition hover:bg-fg/90 disabled:opacity-60">
              {status === 'sending' ? 'Sending…' : last ? def.submitLabel : 'Next'}
            </button>
          </div>
          <p className="mt-5 text-xs text-fg/45">{note}</p>
        </>
      ) : (
        <div className="mt-8 flex items-center justify-between gap-6 border-t border-fg/10 pt-6">
          <p className="max-w-xl text-xs text-fg/45">{note}</p>
          <button type="submit" disabled={status === 'sending'} className="shrink-0 rounded-2xl bg-fg px-6 py-3.5 font-medium text-bg transition hover:bg-fg/90 disabled:opacity-60">
            {status === 'sending' ? 'Sending…' : def.submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}

/** The inline request-a-demo form. Renders in the browser only, so it can pick up an unsent draft. */
export function DemoForm() {
  const mounted = useMounted();
  if (!mounted) return <div className="min-h-[34rem]" aria-busy="true" />;
  return <Form />;
}
