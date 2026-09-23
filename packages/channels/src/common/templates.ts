import { DomainError, ErrorCategory, type TemplateCategory, type TemplateHeader } from '@ocso/domain';

/**
 * Shared pieces of the WhatsApp template adapters (PM/research/10): typed
 * provider errors and the category/media normalization both Twilio and Meta
 * need. Messages never carry secrets (callers redact provider text).
 */

export type TemplateErrorReason = 'not_configured' | 'auth_failed' | 'rejected' | 'not_found' | 'rate_limited' | 'unavailable' | 'unsupported';

const REASONS: Readonly<Record<TemplateErrorReason, { category: ErrorCategory; code: string }>> = {
  not_configured: { category: ErrorCategory.VALIDATION, code: 'templates_not_configured' },
  auth_failed: { category: ErrorCategory.VALIDATION, code: 'templates_auth_failed' },
  rejected: { category: ErrorCategory.VALIDATION, code: 'template_rejected_by_provider' },
  not_found: { category: ErrorCategory.NOT_FOUND, code: 'template_not_found' },
  rate_limited: { category: ErrorCategory.PROVIDER_RATE_LIMITED, code: 'templates_rate_limited' },
  unavailable: { category: ErrorCategory.PROVIDER_UNAVAILABLE, code: 'templates_unavailable' },
  unsupported: { category: ErrorCategory.VALIDATION, code: 'template_unsupported' },
};

export class TemplateProviderError extends DomainError {
  constructor(
    readonly reason: TemplateErrorReason,
    message: string,
  ) {
    super(REASONS[reason].category, REASONS[reason].code, message);
  }
}

/** HTTP status of a failed provider call → error reason (network failures are `unavailable`). */
export function templateReasonForStatus(status: number): TemplateErrorReason {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'rejected';
}

/** Provider category → OCSO (legacy TRANSACTIONAL/OTP included; case-insensitive). */
export function normalizeTemplateCategory(raw: unknown): TemplateCategory | null {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value === 'UTILITY' || value === 'TRANSACTIONAL') return 'UTILITY';
  if (value === 'MARKETING') return 'MARKETING';
  if (value === 'AUTHENTICATION' || value === 'OTP') return 'AUTHENTICATION';
  return null;
}

/** Media header format from a URL's file extension (Twilio media templates carry the URL, not a type). */
export function mediaFormatOfUrl(url: string): TemplateHeader['format'] {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (/\.(mp4|3gp|3gpp|mov)$/.test(path)) return 'VIDEO';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt)$/.test(path)) return 'DOCUMENT';
  return 'IMAGE';
}

/** Up to `max` characters of provider text, whitespace collapsed. */
export function shortText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
