import type { ReactNode } from 'react';

export interface AuthFieldProps {
  name: string;
  label: string;
  type?: 'text' | 'email' | 'password';
  autoComplete?: string;
  defaultValue?: string;
  error?: string | undefined;
  hint?: ReactNode;
  autoFocus?: boolean;
  mono?: boolean;
}

/** Labelled auth input (.auth-field) with an announced inline error. */
export function AuthField({ name, label, type = 'text', autoComplete, defaultValue, error, hint, autoFocus, mono }: AuthFieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="auth-field">
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required
        autoFocus={autoFocus}
        spellCheck={type === 'text' ? false : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 12.5 } : undefined}
      />
      {hint ? (
        <span id={hintId} className="mono-sm" style={{ display: 'block', marginTop: 4, fontSize: 10.5 }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="mono-sm" style={{ display: 'block', marginTop: 4, color: 'var(--danger)' }} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
