import type { ReactNode } from 'react';

interface BaseProps {
  name: string;
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  /** Id prefix so the same field name can appear in two forms on one page. */
  idPrefix?: string;
}

function ids(p: BaseProps) {
  const id = `${p.idPrefix ?? 'f'}-${p.name}`;
  const describedBy = [p.error ? `${id}-error` : null, p.hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return { id, describedBy };
}

function Messages({ id, error, hint }: { id: string; error?: string | undefined; hint?: ReactNode }) {
  return (
    <>
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
    </>
  );
}

export interface TextFieldProps extends BaseProps {
  type?: 'text' | 'email' | 'password' | 'number';
  defaultValue?: string | undefined;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
}

/** Labelled input (.fld) with hint and announced error. */
export function TextField(props: TextFieldProps) {
  const { id, describedBy } = ids(props);
  return (
    <div className="fld">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type ?? 'text'}
        defaultValue={props.defaultValue}
        autoComplete={props.autoComplete}
        required={props.required}
        disabled={props.disabled}
        min={props.min}
        max={props.max}
        placeholder={props.placeholder}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      <Messages id={id} error={props.error} hint={props.hint} />
    </div>
  );
}

export interface SelectFieldProps extends BaseProps {
  options: Array<{ value: string; label: string }>;
  defaultValue?: string | undefined;
  disabled?: boolean;
}

export function SelectField(props: SelectFieldProps) {
  const { id, describedBy } = ids(props);
  return (
    <div className="fld">
      <label htmlFor={id}>{props.label}</label>
      <select
        id={id}
        name={props.name}
        defaultValue={props.defaultValue}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Messages id={id} error={props.error} hint={props.hint} />
    </div>
  );
}

export interface CheckboxGroupProps extends BaseProps {
  options: Array<{ value: string; label: string }>;
  defaultValues?: string[];
}

/** Multi-select as pill checkboxes (fieldset + legend for assistive tech). */
export function CheckboxGroup(props: CheckboxGroupProps) {
  const { id, describedBy } = ids(props);
  const checked = new Set(props.defaultValues ?? []);
  return (
    <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }} aria-describedby={describedBy}>
      <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, padding: 0, marginBottom: 5 }}>{props.label}</legend>
      <div className="checks">
        {props.options.map((o) => (
          <label key={o.value}>
            <input type="checkbox" name={props.name} value={o.value} defaultChecked={checked.has(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      <Messages id={id} error={props.error} hint={props.hint} />
    </fieldset>
  );
}
