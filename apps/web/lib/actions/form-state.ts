/** Result a form server action returns to `useActionState`. */
export interface FormState {
  status: 'idle' | 'success' | 'error';
  message?: string;
  /** Per-field messages keyed by input name. */
  fieldErrors?: Record<string, string>;
  /** Echo of non-secret inputs so the form keeps them after an error. */
  values?: Record<string, string>;
}

export const IDLE: FormState = { status: 'idle' };

/** First zod issue per field, keyed by the top-level path segment. */
export function fieldErrorsFrom(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

/** String value of a form field ('' when absent). */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}
