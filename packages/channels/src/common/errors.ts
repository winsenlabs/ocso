import { DomainError, ErrorCategory } from '@ocso/domain';

/**
 * Typed channel errors. Messages and details never carry secrets, tokens or
 * raw provider bodies (build rule §21); callers may log them as-is.
 */

export type MediaErrorReason =
  | 'too_large'
  | 'type_not_allowed'
  | 'type_mismatch'
  | 'host_not_allowed'
  | 'checksum_mismatch'
  | 'invalid_reference'
  | 'not_found'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'download_failed'
  | 'not_applicable';

const MEDIA_REASON_CATEGORY: Readonly<Record<MediaErrorReason, ErrorCategory>> = {
  too_large: ErrorCategory.POLICY_DENIED,
  type_not_allowed: ErrorCategory.POLICY_DENIED,
  type_mismatch: ErrorCategory.POLICY_DENIED,
  host_not_allowed: ErrorCategory.POLICY_DENIED,
  checksum_mismatch: ErrorCategory.VALIDATION,
  invalid_reference: ErrorCategory.VALIDATION,
  not_found: ErrorCategory.NOT_FOUND,
  auth_failed: ErrorCategory.AUTHENTICATION,
  rate_limited: ErrorCategory.PROVIDER_RATE_LIMITED,
  timeout: ErrorCategory.TIMEOUT,
  download_failed: ErrorCategory.PROVIDER_UNAVAILABLE,
  not_applicable: ErrorCategory.VALIDATION,
};

/** Reasons meaning the media itself is unacceptable: persist it as REJECTED, never retry. */
const MEDIA_REJECTIONS: ReadonlySet<MediaErrorReason> = new Set([
  'too_large',
  'type_not_allowed',
  'type_mismatch',
  'host_not_allowed',
  'checksum_mismatch',
]);

export class ChannelMediaError extends DomainError {
  constructor(
    readonly reason: MediaErrorReason,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(MEDIA_REASON_CATEGORY[reason], `media_${reason}`, message, details);
  }

  /** True when the media should be stored as REJECTED with this message as `rejectionReason`. */
  get rejected(): boolean {
    return MEDIA_REJECTIONS.has(this.reason);
  }
}

export const channelConfigError = (problems: readonly string[]): DomainError =>
  new DomainError(ErrorCategory.VALIDATION, 'invalid_channel_config', `channel configuration invalid: ${problems.join('; ')}`, {
    problems: [...problems],
  });

export const invalidInbound = (code: string, message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError(ErrorCategory.VALIDATION, code, message, details);

export const invalidOutbound = (code: string, message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError(ErrorCategory.VALIDATION, code, message, details);

export const unauthenticated = (code: string, message: string): DomainError =>
  new DomainError(ErrorCategory.AUTHENTICATION, code, message);
