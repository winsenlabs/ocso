import { safeProviderText } from '../common/redact.js';
import { sendFailure, type SendFailure } from '../common/send-failure.js';
import type { ConnectorResult } from './connector.js';

/**
 * Bot Connector failure → OCSO send failure. The HTTP status decides
 * (docs: "Bot Connector API error codes"); the connector's error code is
 * kept, redacted, in the message. `retriable` drives the outbox backoff.
 */

/** Codes that mean the bot can no longer reach the person (removed, blocked, uninstalled, conversation gone). */
const UNDELIVERABLE_CODES = new Set(['ConversationNotFound', 'BotNotInConversationRoster', 'ConversationBlockedByUser', 'BotDisabledByAdmin', 'NotFound']);

export function mapConnectorFailure(result: Exclude<ConnectorResult, { kind: 'ok' }>, secrets: readonly string[]): SendFailure {
  switch (result.kind) {
    case 'network':
      // Ambiguous: the connector may have accepted the activity. Retrying is at-least-once (ADR-007).
      return sendFailure(result.timedOut ? 'timeout' : 'network_error', result.timedOut ? 'Bot Connector request timed out' : 'Bot Connector request failed before a response', true);
    case 'token':
      return { ok: false, errorCode: result.failure.errorCode, message: result.failure.message, retriable: result.failure.retriable };
    case 'blocked':
      return sendFailure('invalid_recipient', result.reason);
    case 'error': {
      const code = safeProviderText(result.code, secrets, 80);
      const text = `Bot Connector answered HTTP ${result.status}${code ? ` (${code})` : ''}${result.retryAfterSeconds === undefined ? '' : ` (retry after ${result.retryAfterSeconds}s)`}`;
      if (result.status === 429) return sendFailure('rate_limited', text, true);
      if (result.status >= 500) return sendFailure('provider_unavailable', text, true);
      if (result.status === 401) return sendFailure('auth_failed', `${text}: the app ID or client secret is not accepted for this bot`);
      if (result.status === 404 || (result.code && UNDELIVERABLE_CODES.has(result.code))) return sendFailure('recipient_undeliverable', text);
      if (result.status === 403) return sendFailure('permission_denied', text);
      if (result.status === 400 || result.status === 413) return sendFailure('invalid_request', text);
      return sendFailure('provider_rejected', text);
    }
  }
}

export { sendFailure, type SendFailure };
