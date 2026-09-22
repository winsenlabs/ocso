import { safeProviderText } from '../common/redact.js';
import { sendFailure, type SendFailure } from '../common/send-failure.js';
import type { TwilioError, TwilioResult } from './rest-client.js';

/**
 * Twilio error code -> OCSO send failure (PM/research/06 §5, twilio.com/docs/api/errors).
 * Lookup table first, HTTP status as fallback. `retriable` drives outbox
 * backoff; `requiresTemplate` (63016) means only a Content Template
 * (ContentSid) can reach the customer now.
 */

interface FailureRule {
  errorCode: string;
  retriable: boolean;
  requiresTemplate?: true;
}

const rule = (errorCode: string, retriable: boolean, requiresTemplate?: true): FailureRule =>
  requiresTemplate ? { errorCode, retriable, requiresTemplate } : { errorCode, retriable };

const RATE_LIMITED = rule('rate_limited', true);
const AUTH_FAILED = rule('auth_failed', false);
const UNDELIVERABLE = rule('recipient_undeliverable', false);
const INVALID_REQUEST = rule('invalid_request', false);
const PROVIDER_UNAVAILABLE = rule('provider_unavailable', true);

export const TWILIO_ERROR_RULES: ReadonlyMap<number, FailureRule> = new Map<number, FailureRule>([
  [63016, rule('outside_session_window', false, true)],
  [63018, RATE_LIMITED],
  [20429, RATE_LIMITED],
  [20003, AUTH_FAILED],
  [63001, AUTH_FAILED],
  [63007, rule('invalid_sender', false)],
  [63003, UNDELIVERABLE],
  [63024, UNDELIVERABLE],
  [21211, UNDELIVERABLE],
  [21614, UNDELIVERABLE],
  [30007, rule('filtered', false)],
  [21610, rule('recipient_opted_out', false)],
  [63032, rule('engagement_limited', false)],
  [63049, rule('engagement_limited', false)],
  [63051, rule('account_restricted', false)],
  [63038, rule('daily_limit_reached', false)],
  [63005, rule('content_rejected', false)],
  [63021, rule('unsupported_message_type', false)],
  [63019, rule('media_download_failed', true)],
  [21620, rule('invalid_media_url', false)],
  [63030, INVALID_REQUEST],
  [21617, INVALID_REQUEST],
  [30008, rule('provider_error', true)],
]);

function ruleForHttpStatus(status: number): FailureRule {
  if (status === 429) return RATE_LIMITED;
  if (status === 401) return AUTH_FAILED;
  if (status === 403) return rule('permission_denied', false);
  if (status >= 500) return PROVIDER_UNAVAILABLE;
  return rule('provider_rejected', false);
}

function describe(status: number, error: TwilioError, secrets: readonly string[]): string {
  const code = error.code === undefined ? `HTTP ${status}` : `Twilio error ${error.code}`;
  const text = safeProviderText(error.message, secrets);
  return text ? `WhatsApp (Twilio) ${code}: ${text}` : `WhatsApp (Twilio) ${code}`;
}

/** Map a failed REST call to a SendResult failure. Messages are redacted. */
export function mapTwilioFailure(result: Exclude<TwilioResult, { kind: 'ok' }>, secrets: readonly string[]): SendFailure {
  if (result.kind === 'network') {
    // Ambiguous: Twilio may have accepted the message. Retrying is at-least-once (ADR-007).
    return {
      ok: false,
      errorCode: result.timedOut ? 'timeout' : 'network_error',
      message: result.timedOut ? 'Twilio request timed out' : 'Twilio request failed before a response',
      retriable: true,
    };
  }
  const chosen = (result.error.code === undefined ? undefined : TWILIO_ERROR_RULES.get(result.error.code)) ?? ruleForHttpStatus(result.status);
  const failure: SendFailure = { ok: false, errorCode: chosen.errorCode, message: describe(result.status, result.error, secrets), retriable: chosen.retriable };
  return chosen.requiresTemplate ? { ...failure, requiresTemplate: true } : failure;
}

export { sendFailure, type SendFailure };
