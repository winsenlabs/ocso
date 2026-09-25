import type { Field } from '@/content/forms';

export const inputClass =
  'w-full rounded-xl border border-fg/12 bg-fg/[0.04] px-4 py-2.5 text-[15px] text-fg placeholder:text-fg/30 outline-none transition focus:border-accent/70 focus:bg-fg/[0.06] aria-[invalid=true]:border-danger/70';

const pill = (on: boolean, error?: string) =>
  `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition ${on ? 'border-accent bg-accent/15 text-fg' : 'border-fg/15 text-fg/70 hover:border-fg/35 hover:text-fg'} ${error ? 'border-danger/60' : ''}`;

const tick = (
  <svg viewBox="0 0 12 12" className="size-3 text-accent" aria-hidden>
    <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Err({ id, error }: { id: string; error?: string | undefined }) {
  return error ? (
    <span id={`${id}-err`} className="mt-1.5 block text-xs text-danger">
      {error}
    </span>
  ) : null;
}

/** Several choices as chips. */
export function MultiField({ field, value, error, onChange }: { field: Field; value: string[]; error?: string | undefined; onChange: (v: string[]) => void }) {
  const id = `f-${field.name}`;
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);
  return (
    <fieldset aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="mb-1 text-sm text-fg/70">{field.label}</legend>
      <p className="mb-2.5 text-xs text-fg/45">Choose all that apply.</p>
      <div id={id} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        {field.options?.map((o) => {
          const on = value.includes(o);
          return (
            <button key={o} type="button" aria-pressed={on} onClick={() => toggle(o)} className={pill(on, error)}>
              {o}
              {on && tick}
            </button>
          );
        })}
      </div>
      <Err id={id} error={error} />
    </fieldset>
  );
}

/** One choice as chips, or as radio cards when each option has a hint. */
export function ChoiceField({ field, value, error, onChange }: { field: Field; value: string; error?: string | undefined; onChange: (v: string) => void }) {
  const id = `f-${field.name}`;
  const cards = !!field.hints;
  return (
    <fieldset aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="mb-2 text-sm text-fg/70">
        {field.label}
        {!field.required && <span className="text-fg/35"> (optional)</span>}
      </legend>
      <div id={id} tabIndex={-1} role="radiogroup" className={`outline-none ${cards ? 'grid gap-2 sm:grid-cols-2 lg:grid-cols-1' : 'flex flex-wrap gap-2'}`}>
        {field.options?.map((o) => {
          const on = value === o;
          const pick = () => onChange(on && !field.required ? '' : o);
          return cards ? (
            <button key={o} type="button" role="radio" aria-checked={on} onClick={pick} className={`rounded-xl border px-3.5 py-2.5 text-left transition ${on ? 'border-accent bg-accent/10' : 'border-fg/12 hover:border-fg/30'} ${error ? 'border-danger/60' : ''}`}>
              <span className="flex items-center justify-between gap-3 text-sm font-medium text-fg">
                {o}
                <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${on ? 'border-accent bg-accent' : 'border-fg/25'}`}>{on && <span className="size-1.5 rounded-full bg-white" />}</span>
              </span>
              <span className="mt-0.5 block text-xs text-fg/50">{field.hints?.[o]}</span>
            </button>
          ) : (
            <button key={o} type="button" role="radio" aria-checked={on} onClick={pick} className={pill(on, error)}>
              {o}
            </button>
          );
        })}
      </div>
      <Err id={id} error={error} />
    </fieldset>
  );
}

export function FieldInput({ field, value, error, onChange }: { field: Field; value: string; error?: string | undefined; onChange: (v: string) => void }) {
  const id = `f-${field.name}`;
  const common = {
    id,
    name: field.name,
    value,
    required: field.required,
    maxLength: field.max,
    placeholder: field.placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-err` : undefined,
  } as const;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-2 block text-sm text-fg/70">
        {field.label}
        {!field.required && <span className="text-fg/35"> (optional)</span>}
      </span>
      {field.type === 'textarea' ? (
        <textarea {...common} rows={4} onChange={(e) => onChange(e.target.value)} className={`${inputClass} resize-y`} />
      ) : (
        <input {...common} type={field.type} autoComplete={field.autoComplete} onChange={(e) => onChange(e.target.value)} className={inputClass} />
      )}
      <Err id={id} error={error} />
    </label>
  );
}
