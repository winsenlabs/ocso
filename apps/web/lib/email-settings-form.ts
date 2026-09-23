/**
 * Pure helpers for the Settings → Email card: test-recipient parsing and
 * turning API results into operator-facing text. No server-only imports, so
 * the unit tests exercise them directly.
 */
import type { FormState } from './actions/form-state';

/** GET /v1/settings/email — the deployment's email configuration (never secrets). Driver names are open (EMAIL_DRIVER). */
export interface EmailSettings {
  driver: string;
  /** The driver's display name from the API (absent on older APIs). */
  label?: string | undefined;
  from: string | null;
  replyTo: string | null;
  /** False for a non-delivering driver (log): nothing is delivered. */
  configured: boolean;
  warnings: string[];
}

/** POST /v1/settings/email/test result. */
export interface EmailTestResult {
  ok: boolean;
  driver: string;
  label?: string | undefined;
  /** False when the driver never hands messages to anyone: a "sent" test reached nobody. */
  delivers?: boolean | undefined;
  id: string | null;
  error?: string | undefined;
  category?: string | undefined;
  retriable?: boolean | undefined;
  warning?: string | undefined;
}

export type NoticeTone = 'info' | 'warn' | 'error';

/** Test-send form state: a FormState plus the banner tone (a non-delivering "success" is a warning). */
export interface EmailTestState extends FormState {
  tone?: NoticeTone;
}

/** Display name of the deployment's email driver: the API's label, else the EMAIL_DRIVER name. */
export const driverLabel = (s: { driver: string; label?: string | undefined }): string => s.label ?? s.driver;

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
  if (result.ok && result.delivers === false) {
    return { tone: 'warn', message: `Not delivered: the ${result.driver} driver does not send email.${warning}` };
  }
  if (result.ok) {
    const id = result.id ? ` · message id ${result.id}` : '';
    return { tone: result.warning ? 'warn' : 'info', message: `Test email sent via ${driverLabel(result)}${id}.${warning}` };
  }
  const hint = CATEGORY_HINTS[result.category ?? 'unknown'] ?? CATEGORY_HINTS['unknown']!;
  const detail = result.error ? ` (${result.error})` : '';
  const retry = result.retriable && result.category !== 'rate_limited' && result.category !== 'unavailable' ? ' A retry may succeed.' : '';
  return { tone: 'error', message: `${hint}${detail}${retry}${warning}` };
}

/** Status chip for the card: can the deployment actually deliver email? */
export function deliveryStatus(settings: EmailSettings): { tone: 'good' | 'warn'; label: string } {
  if (settings.configured) return { tone: 'good', label: 'delivering' };
  return { tone: 'warn', label: `not delivered · ${settings.driver} driver` };
}

/** Notes shown under the status: API warnings first, plus the explanation for a non-delivering driver. */
export function statusNotes(settings: EmailSettings): string[] {
  const notes = [...settings.warnings];
  if (!settings.configured && !notes.some((n) => /deliver|log/i.test(n))) {
    notes.push(`Invites, password resets and sign-in codes are not delivered by the ${settings.driver} driver; nobody receives them.`);
  }
  return notes;
}
