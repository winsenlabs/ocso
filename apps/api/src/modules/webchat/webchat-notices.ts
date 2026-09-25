import type { ControlState } from '@ocso/domain';

/**
 * Customer-safe projection of control changes (docs/archive/specs/07 §5). Customers learn
 * only that they are waiting for / talking to a colleague (first name), that
 * the assistant is back, or that the conversation was closed — never queues,
 * reasons, commands or internal state names.
 */

export type WebChatNoticeKind = 'waiting' | 'joined' | 'ai_resumed' | 'resolved';

export interface WebChatNotice {
  /** Id of the underlying system-event interaction (dedupe key across live + history). */
  id: string;
  seq: number;
  kind: WebChatNoticeKind;
  /** Colleague first name for `joined`, assistant name for `ai_resumed`. */
  name: string | null;
  at: string;
}

/** Who is driving, as the customer may see it. */
export type WebChatMode = 'ai' | 'waiting' | 'human' | 'closed';

export interface ControlChangeFacts {
  from: string;
  to: string;
  actorType: string;
  actorId: string | null;
}

const WAITING: ReadonlySet<string> = new Set<ControlState>(['ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN']);
const AI: ReadonlySet<string> = new Set<ControlState>(['AI_ACTIVE', 'AI_RESUMING']);

export function noticeKind(change: ControlChangeFacts): WebChatNoticeKind | null {
  if (WAITING.has(change.to) && !WAITING.has(change.from)) return 'waiting';
  if (change.to === 'HUMAN_ACTIVE') return 'joined';
  if (AI.has(change.to) && (change.from === 'HUMAN_ACTIVE' || WAITING.has(change.from))) return 'ai_resumed';
  if (change.to === 'RESOLVED' && change.from !== 'RESOLVED') return 'resolved';
  return null;
}

export function modeOf(controlState: string): WebChatMode {
  if (WAITING.has(controlState)) return 'waiting';
  if (controlState === 'HUMAN_ACTIVE') return 'human';
  if (controlState === 'RESOLVED') return 'closed';
  return 'ai';
}

/** Parse the STRUCTURED part of a `system.control_changed` event; null for anything else. */
export function controlChangeFacts(part: unknown): ControlChangeFacts | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as { type?: unknown; schema?: unknown; data?: unknown };
  if (p.type !== 'STRUCTURED' || p.schema !== 'system.control_changed' || !p.data || typeof p.data !== 'object') return null;
  const d = p.data as Record<string, unknown>;
  if (typeof d['from'] !== 'string' || typeof d['to'] !== 'string') return null;
  return {
    from: d['from'],
    to: d['to'],
    actorType: typeof d['actorType'] === 'string' ? d['actorType'] : 'SYSTEM',
    actorId: typeof d['actorId'] === 'string' ? d['actorId'] : null,
  };
}

/** First name only: customers see "Priya", never a full name or email. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}
