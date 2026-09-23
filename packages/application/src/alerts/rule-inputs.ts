import { ALERT_KINDS, ALERT_SEVERITIES } from '@ocso/alerts';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';

const RoleSchema = z.enum(ROLES);
const DAY = 86_400;

/** Field schemas without defaults (shared by create and patch). */
const fields = {
  name: z.string().trim().min(1).max(160),
  kind: z.enum(ALERT_KINDS),
  condition: z.string().trim().min(1).max(64),
  /** Validated per condition by the evaluator's own schema. */
  params: z.record(z.string(), z.unknown()),
  /** null = platform-wide; otherwise the rule applies to one virtual agent. */
  agentId: z.uuid().nullable(),
  windowSeconds: z.number().int().min(60).max(30 * DAY),
  severity: z.enum(ALERT_SEVERITIES),
  audienceRoles: z.array(RoleSchema).min(1).max(3),
  destinationIds: z.array(z.uuid()).max(20),
  /** A resolved fingerprint is not reopened within this many seconds. */
  dedupeWindowSeconds: z.number().int().min(0).max(30 * DAY),
  autoResolve: z.boolean(),
  enabled: z.boolean(),
};

export const AlertRuleInput = z.object({
  name: fields.name,
  kind: fields.kind,
  condition: fields.condition,
  params: fields.params.default({}),
  agentId: fields.agentId.default(null),
  windowSeconds: fields.windowSeconds.default(300),
  severity: fields.severity.default('WARNING'),
  audienceRoles: fields.audienceRoles,
  destinationIds: fields.destinationIds.default([]),
  dedupeWindowSeconds: fields.dedupeWindowSeconds.default(3600),
  autoResolve: fields.autoResolve.default(true),
  /** Ignored on create: a new rule is a disabled draft until an approved ACTIVATE turns it on (PM/research/11 §4). */
  enabled: fields.enabled.default(false),
});
export type AlertRuleInput = z.infer<typeof AlertRuleInput>;

export const AlertRulePatch = z.object(fields).partial();
export type AlertRulePatch = z.infer<typeof AlertRulePatch>;

/** What an approved alert-rule UPDATE applies: the patch without `enabled` (on is ACTIVATE, off a stop) and `kind` (fixed once approved). */
export const AlertRulePatchFields = AlertRulePatch.omit({ enabled: true, kind: true });
export const AlertRuleApprovalPatch = AlertRulePatchFields.strict();
export type AlertRuleApprovalPatch = z.infer<typeof AlertRuleApprovalPatch>;

export const AlertRuleListQuery = z.object({
  kind: z.enum(ALERT_KINDS).optional(),
  agentId: z.uuid().optional(),
});
export type AlertRuleListQuery = z.infer<typeof AlertRuleListQuery>;
