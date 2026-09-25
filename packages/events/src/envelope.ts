import { randomUUID } from 'node:crypto';
import type { OcsoEventType, OcsoEventPayloads } from './catalogue.js';

/** Canonical event envelope (docs/archive/specs/14 §4). */
export interface OcsoEvent<T extends OcsoEventType = OcsoEventType> {
  id: string;
  type: T;
  version: number;
  occurredAt: string;
  correlationId: string;
  conversationId?: string | undefined;
  agentId?: string | undefined;
  payload: OcsoEventPayloads[T];
}

export interface EventContext {
  correlationId: string;
  conversationId?: string | undefined;
  agentId?: string | undefined;
}

export function createEvent<T extends OcsoEventType>(
  type: T,
  payload: OcsoEventPayloads[T],
  ctx: EventContext,
  version = 1,
): OcsoEvent<T> {
  return {
    id: randomUUID(),
    type,
    version,
    occurredAt: new Date().toISOString(),
    correlationId: ctx.correlationId,
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    payload,
  };
}
