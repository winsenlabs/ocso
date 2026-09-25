import { z } from 'zod';

/** Business purpose. Changes instructions, routing, KPIs — never the runtime (docs/archive/specs/01 §5). */
export const ConversationType = z.enum(['SUPPORT', 'SALES', 'COLLECTIONS', 'ONBOARDING', 'CUSTOM']);
export type ConversationType = z.infer<typeof ConversationType>;

export const Priority = z.enum(['P1', 'P2', 'P3', 'P4']);
export type Priority = z.infer<typeof Priority>;

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { P1: 1, P2: 2, P3: 3, P4: 4 };

export function comparePriority(a: Priority, b: Priority): number {
  return PRIORITY_RANK[a] - PRIORITY_RANK[b];
}

/** Higher of two priorities (P1 is highest). */
export function raisePriority(current: Priority, requested: Priority): Priority {
  return comparePriority(requested, current) < 0 ? requested : current;
}

export const HandoffMode = z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']);
export type HandoffMode = z.infer<typeof HandoffMode>;

/** What triggered an escalation (docs/archive/specs/01 §6). */
export const HandoffTrigger = z.enum([
  'CUSTOMER_REQUEST',
  'AGENT_DECISION',
  'POLICY',
  'INTENT',
  'RISK',
  'TOOL_FAILURE',
  'SLA',
  'LOW_CONFIDENCE',
  'BUSINESS_RULE',
  'HUMAN_REQUEST',
  'SENSITIVE_ACTION',
]);
export type HandoffTrigger = z.infer<typeof HandoffTrigger>;

/** Turn behavior when customer messages arrive mid-turn (ADR-019). */
export const MidTurnPolicy = z.enum(['QUEUE_BEHIND', 'CANCEL_AND_RESTART']);
export type MidTurnPolicy = z.infer<typeof MidTurnPolicy>;

/** Short display id used in the UI and logs, e.g. conv_9f41ac. */
export function displayId(prefix: string, id: string): string {
  return `${prefix}_${id.replace(/-/g, '').slice(-6)}`;
}
