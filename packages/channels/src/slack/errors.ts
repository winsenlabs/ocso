import { safeProviderText } from '../common/redact.js';
import { sendFailure, type SendFailure } from '../common/send-failure.js';
import type { SlackResult } from './web-api.js';

/**
 * Slack Web API error -> OCSO send failure (api.slack.com/methods/chat.postMessage#errors).
 * Slack answers most failures with HTTP 200 and `ok: false` plus an error
 * code; the code decides first, the HTTP status is the fallback. `retriable`
 * drives the outbox backoff.
 */

interface FailureRule {
  errorCode: string;
  retriable: boolean;
}

const rule = (errorCode: string, retriable: boolean): FailureRule => ({ errorCode, retriable });

const RATE_LIMITED = rule('rate_limited', true);
const AUTH_FAILED = rule('auth_failed', false);
const PERMISSION_DENIED = rule('permission_denied', false);
const UNDELIVERABLE = rule('recipient_undeliverable', false);
const INVALID_REQUEST = rule('invalid_request', false);
const PROVIDER_UNAVAILABLE = rule('provider_unavailable', true);

export const SLACK_ERROR_RULES: ReadonlyMap<string, FailureRule> = new Map<string, FailureRule>([
  ['ratelimited', RATE_LIMITED],
  ['rate_limited', RATE_LIMITED],
  ['message_limit_exceeded', RATE_LIMITED],
  ['not_authed', AUTH_FAILED],
  ['invalid_auth', AUTH_FAILED],
  ['account_inactive', AUTH_FAILED],
  ['token_revoked', AUTH_FAILED],
  ['token_expired', AUTH_FAILED],
  ['no_permission', PERMISSION_DENIED],
  ['missing_scope', PERMISSION_DENIED],
  ['not_allowed_token_type', PERMISSION_DENIED],
  ['ekm_access_denied', PERMISSION_DENIED],
  ['team_access_not_granted', PERMISSION_DENIED],
  ['restricted_action', PERMISSION_DENIED],
  ['restricted_action_read_only_channel', PERMISSION_DENIED],
  ['restricted_action_thread_only_channel', PERMISSION_DENIED],
  ['restricted_action_non_threadable_channel', PERMISSION_DENIED],
  ['channel_not_found', UNDELIVERABLE],
  ['not_in_channel', UNDELIVERABLE],
  ['is_archived', UNDELIVERABLE],
  ['user_not_found', UNDELIVERABLE],
  ['user_not_visible', UNDELIVERABLE],
  ['user_disabled', UNDELIVERABLE],
  ['cannot_dm_bot', UNDELIVERABLE],
  ['messages_tab_disabled', UNDELIVERABLE],
  ['msg_too_long', INVALID_REQUEST],
  ['no_text', INVALID_REQUEST],
  ['invalid_blocks', INVALID_REQUEST],
  ['invalid_blocks_format', INVALID_REQUEST],
  ['too_many_attachments', INVALID_REQUEST],
  ['invalid_arguments', INVALID_REQUEST],
  ['invalid_arg_name', INVALID_REQUEST],
  ['invalid_array_arg', INVALID_REQUEST],
  ['invalid_charset', INVALID_REQUEST],
  ['invalid_form_data', INVALID_REQUEST],
  ['invalid_post_type', INVALID_REQUEST],
  ['invalid_json', INVALID_REQUEST],
  ['json_not_object', INVALID_REQUEST],
  ['missing_post_type', INVALID_REQUEST],
  ['invalid_response', rule('provider_error', false)],
  ['fatal_error', PROVIDER_UNAVAILABLE],
  ['internal_error', PROVIDER_UNAVAILABLE],
  ['service_unavailable', PROVIDER_UNAVAILABLE],
  ['request_timeout', PROVIDER_UNAVAILABLE],
  ['team_added_to_org', PROVIDER_UNAVAILABLE],
]);

function ruleForHttpStatus(status: number): FailureRule {
  if (status === 429) return RATE_LIMITED;
  if (status === 401) return AUTH_FAILED;
  if (status === 403) return PERMISSION_DENIED;
  if (status >= 500) return PROVIDER_UNAVAILABLE;
  return rule('provider_rejected', false);
}

/** Map a failed Web API call to a SendResult failure. Slack error codes are short identifiers; still redacted. */
export function mapSlackFailure(result: Exclude<SlackResult, { kind: 'ok' }>, secrets: readonly string[]): SendFailure {
  if (result.kind === 'network') {
    // Ambiguous: Slack may have posted the message. Retrying is at-least-once (ADR-007).
    return {
      ok: false,
      errorCode: result.timedOut ? 'timeout' : 'network_error',
      message: result.timedOut ? 'Slack request timed out' : 'Slack request failed before a response',
      retriable: true,
    };
  }
  const chosen = SLACK_ERROR_RULES.get(result.error) ?? ruleForHttpStatus(result.status);
  const code = safeProviderText(result.error, secrets, 80);
  const wait = result.retryAfterSeconds === undefined ? '' : ` (retry after ${result.retryAfterSeconds}s)`;
  return { ok: false, errorCode: chosen.errorCode, message: `Slack error ${code || `HTTP ${result.status}`}${wait}`, retriable: chosen.retriable };
}

export { sendFailure, type SendFailure };
