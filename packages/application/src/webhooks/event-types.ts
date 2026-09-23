import type { OcsoEventType } from '@ocso/events';

/**
 * Events external systems may subscribe to (design/04 Webhooks tab). Payloads
 * carry identifiers and metadata only — never message content, notes, tool
 * arguments or credentials. Internal plumbing (config/cache/worker/copilot)
 * and ephemeral streaming events are excluded.
 */
export const WEBHOOK_EVENT_TYPES = [
  'conversation.created',
  'conversation.control_changed',
  'conversation.resolved',
  'interaction.received',
  'interaction.sent',
  'interaction.delivery_updated',
  'handoff.requested',
  'handoff.assigned',
  'assignment.changed',
  'ai.resumed',
  'agent.turn_completed',
  'model.request_completed',
  'model.fallback',
  'tool.completed',
  'tool.failed',
  'tool.confirmation_requested',
  'tool.confirmation_decided',
  'alert.opened',
  'alert.updated',
  'alert.resolved',
] as const satisfies readonly OcsoEventType[];

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Synthetic event sent by "Send test". */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

const KNOWN = new Set<string>(WEBHOOK_EVENT_TYPES);
const PREFIXES = new Set(WEBHOOK_EVENT_TYPES.map((t) => t.split('.')[0]!));

/** A subscription pattern: an exact type, `<area>.*`, or `*`. */
export function isValidPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return PREFIXES.has(pattern.slice(0, -2));
  return KNOWN.has(pattern);
}

export function matchesAny(patterns: readonly string[], type: string): boolean {
  if (!KNOWN.has(type)) return false;
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}
