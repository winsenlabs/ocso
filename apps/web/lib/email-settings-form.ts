/**
 * Pure helpers for the Settings → Email card: test-recipient parsing and
 * turning API results into operator-facing text. No server-only imports, so
 * the unit tests exercise them directly.
 */
import type { FormState } from './actions/form-state';

export type EmailDriver = 'resend' | 'smtp' | 'log';

/** GET /v1/settings/email — the deployment's email configuration (never secrets). */
export interface EmailSettings {
  driver: EmailDriver;
  from: string | null;
  replyTo: string | null;
  /** False for the log driver: nothing is delivered. */
  configured: boolean;
  warnings: string[];
}

/** POST /v1/settings/email/test result. */
export interface EmailTestResult {
  ok: boolean;
  driver: EmailDriver;
  id: string | null;
  error?: string | undefined;
  category?: string | undefined;
  retriable?: boolean | undefined;
  warning?: string | undefined;
}

export type NoticeTone = 'info' | 'warn' | 'error';

/** Test-send form state: a FormState plus the banner tone (a log-driver "success" is a warning). */
export interface EmailTestState extends FormState {
  tone?: NoticeTone;
}

export const DRIVER_LABELS: Readonly<Record<EmailDriver, string>> = {
  resend: 'Resend',
  smtp: 'SMTP',
  log: 'Log — development only',
};

const CATEGORY_HINTS: Readonly<Record<string, string>> = {
  auth: 'The provider rejected the credentials or the sender. Check the API key or SMTP login and that the sending domain is verified.',
  validation: 'The provider rejected the message. Check the from address and the recipient.',
  rate_limited: 'Rate limit or sending quota reached. Try again shortly.',
  unavailable: 'The email provider is temporarily unavailable. Try again shortly.',
  network: 'Could not reach the email provider (network error or timeout).',
  unknown: 'Sending failed.',
};

const MAX_ADDRESS = 320;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** One plain recipient address for the test send. */
export function parseTestRecipient(raw: string): { ok: true; to: string } | { ok: false; error: string } {
  const to = raw.trim();
  if (!to) return { ok: false, error: 'Enter the address to send the test email to' };
  if (to.length > MAX_ADDRESS) return { ok: false, error: `At most ${MAX_ADDRESS} characters` };
  if (!ADDRESS.test(to)) return { ok: false, error: 'Enter a single email address, e.g. you@example.com' };
  return { ok: true, to };
}

/** Banner tone and text for a test-send result. Provider errors are shown with a hint for their category. */
export function describeTestResult(result: EmailTestResult): { tone: NoticeTone; message: string } {
  const warning = result.warning ? ` ${result.warning}` : '';
  if (result.ok && result.driver === 'log') {
    return { tone: 'warn', message: `Not delivered: the log driver only writes emails to the server log.${warning}` };
  }
  if (result.ok) {
    const id = result.id ? ` · message id ${result.id}` : '';
    return { tone: result.warning ? 'warn' : 'info', message: `Test email sent via ${DRIVER_LABELS[result.driver]}${id}.${warning}` };
  }
  const hint = CATEGORY_HINTS[result.category ?? 'unknown'] ?? CATEGORY_HINTS['unknown']!;
  const detail = result.error ? ` (${result.error})` : '';
  const retry = result.retriable && result.category !== 'rate_limited' && result.category !== 'unavailable' ? ' A retry may succeed.' : '';
  return { tone: 'error', message: `${hint}${detail}${retry}${warning}` };
}

/** Status chip for the card: can the deployment actually deliver email? */
export function deliveryStatus(settings: EmailSettings): { tone: 'good' | 'warn'; label: string } {
  if (settings.configured) return { tone: 'good', label: 'delivering' };
  return { tone: 'warn', label: settings.driver === 'log' ? 'not delivered · log only' : 'not configured' };
}

/** Notes shown under the status: API warnings first, plus the log-driver explanation when it applies. */
export function statusNotes(settings: EmailSettings): string[] {
  const notes = [...settings.warnings];
  if (settings.driver === 'log' && !notes.some((n) => /log/i.test(n))) {
    notes.push('Invites, password resets and sign-in codes are only written to the server log; nobody receives them.');
  }
  return notes;
}
