import { createHash } from 'node:crypto';
import { describeRecipients, mailboxAddress } from './address.js';
import { EmailSendError, type EmailErrorCategory, type EmailMessage, type EmailSender, type EmailSendResult } from './contract.js';

/** Minimal fetch signature so tests (and egress guards) can inject their own. */
export type EmailFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendSenderOptions {
  apiKey: string;
  /** EMAIL_FROM, already validated (`Name <addr@verified-domain>`). */
  from: string;
  /** Default Reply-To (EMAIL_REPLY_TO); a message's own replyTo wins. */
  replyTo?: string | null | undefined;
  /** Default https://api.resend.com; overridable for tests. */
  baseUrl?: string | undefined;
  fetch?: EmailFetch | undefined;
  /** Per-request timeout; default 10 s. */
  timeoutMs?: number | undefined;
}

/** Resend limits (resend.com/docs/api-reference/emails/send-email). */
export const RESEND_LIMITS = { recipients: 50, tags: 75, tagChars: 256, idempotencyKeyChars: 256 } as const;
const TAG_INVALID = /[^A-Za-z0-9_-]/g;

/**
 * Resend HTTPS API driver (POST /emails). No SDK: one JSON request, bounded
 * by a timeout, never following redirects. Errors are EmailSendError with a
 * retriable flag — 429 / 5xx / network are transient; validation and auth are not.
 * The API key and recipient addresses never appear in error messages.
 */
export class ResendEmailSender implements EmailSender {
  readonly driver = 'resend' as const;
  readonly from: string;
  private readonly endpoint: string;
  private readonly fetchFn: EmailFetch;

  constructor(private readonly options: ResendSenderOptions) {
    if (!options.apiKey) throw new Error('Resend sender requires an API key');
    this.from = options.from;
    this.endpoint = `${(options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '')}/emails`;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const to = [message.to].flat();
    if (to.length === 0 || to.length > RESEND_LIMITS.recipients) {
      throw new EmailSendError(`Resend accepts 1–${RESEND_LIMITS.recipients} recipients per email (got ${to.length})`, false, null, 'validation');
    }
    const replyTo = message.replyTo ?? this.options.replyTo ?? undefined;
    const tags = resendTags(message.tags);
    const body = {
      from: this.from,
      to,
      subject: message.subject.replace(/[\r\n]+/g, ' '),
      html: message.html,
      text: message.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(tags.length ? { tags } : {}),
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
      'user-agent': 'OCSO-Email/1',
    };
    if (message.idempotencyKey) headers['idempotency-key'] = resendIdempotencyKey(message.idempotencyKey);

    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new EmailSendError(timedOut ? 'Resend request timed out' : 'Resend request failed (network error)', true, null, 'network');
    }
    const text = await response.text().catch(() => '');
    if (response.ok) {
      const id = parseJson(text)?.['id'];
      return { id: typeof id === 'string' ? id : null };
    }
    throw this.failure(response.status, text, to, replyTo);
  }

  private failure(status: number, text: string, to: readonly string[], replyTo: string | undefined): EmailSendError {
    const parsed = parseJson(text);
    const name = typeof parsed?.['name'] === 'string' && /^[a-z_]{1,60}$/.test(parsed['name']) ? parsed['name'] : null;
    const raw = typeof parsed?.['message'] === 'string' ? parsed['message'] : '';
    const detail = scrub(raw, [this.options.apiKey, ...to, ...to.map(mailboxAddress), ...(replyTo ? [replyTo] : [])]);
    const { retriable, category } = classifyResendError(status, name);
    const reason = [name, detail].filter(Boolean).join(': ');
    return new EmailSendError(`Resend HTTP ${status}${reason ? ` (${reason})` : ''} sending to ${describeRecipients(to)}`, retriable, status, category);
  }
}

/** Retriable matrix for Resend responses (resend.com/docs/api-reference/errors). */
export function classifyResendError(status: number, name: string | null): { retriable: boolean; category: EmailErrorCategory } {
  if (status === 429) return { retriable: true, category: 'rate_limited' };
  if (status >= 500) return { retriable: true, category: 'unavailable' };
  if (status === 408 || status === 425) return { retriable: true, category: 'network' };
  if (status === 409) {
    // Another request with the same key is still running: retry later. A changed payload never succeeds.
    return name === 'concurrent_idempotent_requests' || name === 'resource_locked'
      ? { retriable: true, category: 'unavailable' }
      : { retriable: false, category: 'validation' };
  }
  if (status === 401 || status === 403) return { retriable: false, category: 'auth' };
  if (status === 400 || status === 422) return { retriable: false, category: 'validation' };
  return { retriable: false, category: 'unknown' };
}

/**
 * Tags → Resend's `[{ name, value }]`: ASCII letters, digits, `_` and `-`
 * only, at most 256 characters each and 75 tags. Other characters become `_`;
 * empty names are dropped, empty values become `none`.
 */
export function resendTags(tags: Readonly<Record<string, string>> | undefined): Array<{ name: string; value: string }> {
  if (!tags) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const [key, value] of Object.entries(tags)) {
    const name = key.replace(TAG_INVALID, '_').slice(0, RESEND_LIMITS.tagChars);
    if (!name || out.some((t) => t.name === name)) continue;
    out.push({ name, value: (String(value).replace(TAG_INVALID, '_') || 'none').slice(0, RESEND_LIMITS.tagChars) });
    if (out.length === RESEND_LIMITS.tags) break;
  }
  return out;
}

/** Keys over Resend's 256-character limit are hashed, so they stay stable (and idempotent). */
export function resendIdempotencyKey(key: string): string {
  return key.length <= RESEND_LIMITS.idempotencyKeyChars ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Provider text with secrets and addresses removed, one line, bounded. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text.replace(/[\r\n\t]+/g, ' ');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  out = out.replace(/[^\s<>"'`,;:()]+@[^\s<>"'`,;:()]+/g, '[address]').replace(/re_[A-Za-z0-9_]{8,}/g, '[redacted]');
  return out.length > 200 ? `${out.slice(0, 199)}…` : out.trim();
}
