import { safeProviderText } from '../common/redact.js';
import { sendFailure, type SendFailure } from '../common/send-failure.js';
import type { GraphError, GraphResult } from './graph-client.js';

/**
 * Meta error code -> OCSO send failure (PM/research/02 §5, Meta "error
 * codes"). Lookup tables, not a switch: Meta codes first, HTTP status as
 * fallback. `retriable` drives outbox backoff; `requiresTemplate` tells the
 * caller a template message is the only way to reach the customer.
 */

export { sendFailure, type SendFailure };

interface FailureRule {
  errorCode: string;
  retriable: boolean;
  requiresTemplate?: true;
}

const rule = (errorCode: string, retriable: boolean, requiresTemplate?: true): FailureRule =>
  requiresTemplate ? { errorCode, retriable, requiresTemplate } : { errorCode, retriable };

const RATE_LIMITED = rule('rate_limited', true);
const AUTH_FAILED = rule('auth_failed', false);
const PERMISSION_DENIED = rule('permission_denied', false);
const PROVIDER_UNAVAILABLE = rule('provider_unavailable', true);
const INVALID_REQUEST = rule('invalid_request', false);
const ACCOUNT_RESTRICTED = rule('account_restricted', false);
const TEMPLATE_ERROR = rule('template_error', false);

export const META_ERROR_RULES: ReadonlyMap<number, FailureRule> = new Map<number, FailureRule>([
  [131047, rule('outside_session_window', false, true)],
  [131056, rule('rate_limited_pair', true)],
  [130429, RATE_LIMITED],
  [4, RATE_LIMITED],
  [17, RATE_LIMITED],
  [32, RATE_LIMITED],
  [613, RATE_LIMITED],
  [80007, RATE_LIMITED],
  [131048, rule('spam_rate_limited', false)],
  [0, AUTH_FAILED],
  [190, AUTH_FAILED],
  [3, PERMISSION_DENIED],
  [10, PERMISSION_DENIED],
  [368, ACCOUNT_RESTRICTED],
  [131031, ACCOUNT_RESTRICTED],
  [131026, rule('recipient_undeliverable', false)],
  [131049, rule('engagement_limited', false)],
  [131050, rule('recipient_opted_out', false)],
  [131051, rule('unsupported_message_type', false)],
  [131052, rule('media_download_failed', true)],
  [131053, rule('media_upload_failed', false)],
  [100, INVALID_REQUEST],
  [131008, INVALID_REQUEST],
  [131009, INVALID_REQUEST],
  [131021, INVALID_REQUEST],
  [135000, INVALID_REQUEST],
  [1, PROVIDER_UNAVAILABLE],
  [2, PROVIDER_UNAVAILABLE],
  [131000, rule('provider_error', true)],
  [131016, PROVIDER_UNAVAILABLE],
  [133004, PROVIDER_UNAVAILABLE],
]);

/** Code ranges: 200–299 permission errors, 132000–132999 template errors. */
function ruleForMetaCode(code: number | undefined): FailureRule | undefined {
  if (code === undefined) return undefined;
  const exact = META_ERROR_RULES.get(code);
  if (exact) return exact;
  if (code >= 200 && code <= 299) return PERMISSION_DENIED;
  if (code >= 132000 && code <= 132999) return TEMPLATE_ERROR;
  return undefined;
}

function ruleForHttpStatus(status: number): FailureRule {
  if (status === 429) return RATE_LIMITED;
  if (status === 401) return AUTH_FAILED;
  if (status === 403) return PERMISSION_DENIED;
  if (status >= 500) return PROVIDER_UNAVAILABLE;
  return rule('provider_rejected', false);
}

function describe(status: number, error: GraphError, secrets: readonly string[]): string {
  const code = error.code === undefined ? `HTTP ${status}` : `Meta error ${error.code}`;
  const text = safeProviderText([error.message, error.details].filter(Boolean).join(' — '), secrets);
  return text ? `WhatsApp ${code}: ${text}` : `WhatsApp ${code}`;
}

/** Map a failed Graph call to a SendResult failure. Messages are redacted. */
export function mapGraphFailure(result: Exclude<GraphResult, { kind: 'ok' }>, secrets: readonly string[]): SendFailure {
  if (result.kind === 'network') {
    // Ambiguous: the request may have been accepted. Retrying is at-least-once (ADR-007).
    return {
      ok: false,
      errorCode: result.timedOut ? 'timeout' : 'network_error',
      message: result.timedOut ? 'WhatsApp request timed out' : 'WhatsApp request failed before a response',
      retriable: true,
    };
  }
  const chosen = ruleForMetaCode(result.error.code) ?? ruleForHttpStatus(result.status);
  const failure: SendFailure = {
    ok: false,
    errorCode: chosen.errorCode,
    message: describe(result.status, result.error, secrets),
    retriable: chosen.retriable,
  };
  return chosen.requiresTemplate ? { ...failure, requiresTemplate: true } : failure;
}
