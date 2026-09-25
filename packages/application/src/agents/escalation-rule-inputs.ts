import { escalationRules } from '@ocso/db';
import { z } from 'zod';
import { patchOf } from '../shared/patch.js';

/** Deterministic trigger conditions evaluated in code (docs/archive/specs/01 §6); the prompt covers judgement calls. */
export const EscalationCondition = z.object({
  keywords: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
  consecutiveToolFailures: z.number().int().min(1).max(10).optional(),
  customerRequestsHuman: z.boolean().optional(),
  amountAbove: z.number().positive().optional(),
});

export const EscalationRuleInput = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(['CUSTOMER_REQUEST', 'AGENT_DECISION', 'POLICY', 'INTENT', 'RISK', 'TOOL_FAILURE', 'SLA', 'LOW_CONFIDENCE', 'BUSINESS_RULE', 'SENSITIVE_ACTION']),
  condition: EscalationCondition.default({}),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).default('OPEN_PICKUP'),
  targetQueueId: z.uuid().nullable().default(null),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).default('P3'),
  /**
   * Accepted for compatibility and ignored on create: a new rule is always a disabled draft (PM/research/11 §4);
   * turning it on is an approved ACTIVATE. On update, `enabled` goes alone: false is an immediate stop, true a proposal.
   */
  enabled: z.boolean().default(false),
});
export type EscalationRuleInput = z.infer<typeof EscalationRuleInput>;
export const EscalationRulePatch = patchOf(EscalationRuleInput);
export type EscalationRulePatch = z.infer<typeof EscalationRulePatch>;
/** What an approved escalation-rule UPDATE applies: the patch without `enabled` (on/off are ACTIVATE and a stop). */
export const EscalationRuleApprovalPatch = EscalationRulePatch.omit({ enabled: true }).strict();
export type EscalationRuleApprovalPatch = z.infer<typeof EscalationRuleApprovalPatch>;
export type EscalationRuleRow = typeof escalationRules.$inferSelect;
