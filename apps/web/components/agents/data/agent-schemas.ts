import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposalRefSchema } from '@/components/approvals/lib/schemas';

/**
 * Response contracts for the virtual-agent screens (design/02). Shapes mirror
 * apps/api/src/modules/agents/*, modules/mcp/agent-tools.controller.ts and the
 * application services behind them. Client-safe (types are shared with client
 * components); the loaders live in lib/api/agents.ts.
 */

export const CONVERSATION_TYPES = ['SUPPORT', 'SALES', 'COLLECTIONS', 'ONBOARDING', 'CUSTOM'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

/** Business prompt components in compile order (packages/prompt-compiler BUSINESS_COMPONENT_KEYS). */
export const COMPONENT_KEYS = ['identity', 'objective', 'behavior', 'policies', 'tool_instructions', 'escalation', 'channel_constraints', 'business_context'] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export const AgentStatsSchema = z.object({
  agentId: z.string(),
  conversations: z.number(),
  containmentRate: z.number().nullable(),
  escalationRate: z.number().nullable(),
  csat: z.number().nullable(),
  csatResponses: z.number(),
  openConversations: z.number(),
  waitingForHuman: z.number(),
});
export type AgentStats = z.infer<typeof AgentStatsSchema>;

const MultimodalSchema = z.object({ imageInput: z.boolean(), documentInput: z.boolean(), audioInput: z.boolean(), maxMediaPerTurn: z.number() });
export type Multimodal = z.infer<typeof MultimodalSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  purpose: z.string(),
  conversationType: z.string(),
  description: z.string(),
  status: z.enum(['DRAFT', 'LIVE', 'PAUSED']),
  activePromptVersionId: z.string().nullable(),
  modelProfileId: z.string().nullable(),
  summarizerProfileId: z.string().nullable(),
  copilotProfileId: z.string().nullable(),
  defaultQueueId: z.string().nullable(),
  multimodal: MultimodalSchema,
  businessHours: z.object({ timezone: z.string(), humanHours: z.record(z.string(), z.tuple([z.string(), z.string()])) }),
  midTurnPolicy: z.enum(['QUEUE_BEHIND', 'CANCEL_AND_RESTART']),
  maxToolSteps: z.number(),
  copilotEnabled: z.boolean(),
  avatarTone: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Owning teams (ADR-026): only their Leads manage the agent. Empty = unowned (Tech admin assigns). */
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  stats: AgentStatsSchema.nullable(),
});
export type Agent = z.infer<typeof AgentSchema>;
/** `approval`: maker–checker state (approved? pending proposal?) for the header badge and the submit modal. */
export const AgentDetailSchema = AgentSchema.extend({ channelIds: z.array(z.string()), approval: ObjectApprovalStateSchema.optional() });
export type AgentDetail = z.infer<typeof AgentDetailSchema>;

export const PromptComponentSchema = z.object({
  key: z.string(),
  label: z.string(),
  owner: z.string(),
  tag: z.string(),
  help: z.string(),
  /** null for the platform-owned runtime contract. */
  text: z.string().nullable(),
  tokens: z.number().nullable(),
});
export type PromptComponent = z.infer<typeof PromptComponentSchema>;

export const PromptVersionSchema = z.object({
  id: z.string(),
  version: z.number(),
  components: z.record(z.string(), z.string()),
  promptHash: z.string(),
  runtimeContractVersion: z.string(),
  changedComponents: z.array(z.string()),
  parentVersionId: z.string().nullable(),
  reason: z.string(),
  authorId: z.string().nullable(),
  /** Added by the prompts controller; older API builds omit it. */
  authorName: z.string().nullable().default(null),
  correctionIds: z.array(z.string()).nullable(),
  evaluationRunId: z.string().nullable(),
  createdAt: z.string(),
  firstActivatedAt: z.string().nullable(),
});
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

export const PromptSchema = z.object({
  components: z.array(PromptComponentSchema),
  /** The saved draft differs from the active version. */
  dirty: z.boolean(),
  baseVersionId: z.string().nullable(),
  versions: z.array(PromptVersionSchema),
});
export type PromptState = z.infer<typeof PromptSchema>;

export const PreviewSchema = z.object({
  system: z.array(z.object({ key: z.string(), text: z.string(), stable: z.boolean(), breakpointAfter: z.string().optional() })),
  tokenEstimate: z.object({ stable: z.number(), conversation: z.number(), messages: z.number(), total: z.number() }),
  hashes: z.object({
    runtimeContractVersion: z.string(),
    promptVersionHash: z.string(),
    components: z.record(z.string(), z.string()),
    toolSchemaHash: z.string(),
    agentPrefixHash: z.string(),
    conversationContextHash: z.string(),
    customerContextHash: z.string().nullable(),
    fullHash: z.string(),
  }),
});
export type PromptPreview = z.infer<typeof PreviewSchema>;

export const DiffSchema = z.array(z.object({ key: z.string(), before: z.string(), after: z.string() }));
export type PromptDiff = z.infer<typeof DiffSchema>;

export const ESCALATION_TRIGGERS = ['CUSTOMER_REQUEST', 'AGENT_DECISION', 'POLICY', 'INTENT', 'RISK', 'TOOL_FAILURE', 'SLA', 'LOW_CONFIDENCE', 'BUSINESS_RULE', 'SENSITIVE_ACTION'] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EscalationConditionSchema = z.object({
  keywords: z.array(z.string()).optional(),
  consecutiveToolFailures: z.number().optional(),
  customerRequestsHuman: z.boolean().optional(),
  amountAbove: z.number().optional(),
});
export type EscalationCondition = z.infer<typeof EscalationConditionSchema>;

/** A list row's approval state (rules, templates): approved at least once, and the open (or activating) proposal. */
export const ListedApprovalSchema = z.object({ approved: z.boolean(), pending: ProposalRefSchema.nullable() });
export type ListedApproval = z.infer<typeof ListedApprovalSchema>;

export const EscalationRuleSchema = z.object({
  id: z.string(),
  /** null = platform-wide rule. */
  agentId: z.string().nullable(),
  name: z.string(),
  trigger: z.string(),
  condition: EscalationConditionSchema.catch({}),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']),
  targetQueueId: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Maker–checker (PM/research/11 §4): approved at least once (then every change is a proposal), and the proposal waiting on it. */
  approval: ListedApprovalSchema.catch({ approved: false, pending: null }),
});
export type EscalationRule = z.infer<typeof EscalationRuleSchema>;

export const RULE_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in', 'not_in', 'exists'] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const ArgumentRuleSchema = z.object({
  path: z.string(),
  op: z.enum(RULE_OPS),
  value: z.unknown().optional(),
  effect: z.enum(['REQUIRE_CONFIRMATION', 'DENY']),
  message: z.string(),
});
export type ArgumentRule = z.infer<typeof ArgumentRuleSchema>;

export const AgentToolSchema = z.object({
  toolId: z.string(),
  connectionId: z.string(),
  connectionName: z.string(),
  connectionStatus: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  modelName: z.string(),
  description: z.string(),
  riskClass: z.enum(['READ', 'WRITE', 'SENSITIVE']),
  /** false: granted earlier but no longer grantable (un-approved, removed, connection no longer allows the agent). */
  eligible: z.boolean(),
  grant: z.object({ enabled: z.boolean(), alwaysConfirm: z.boolean(), argumentRules: z.array(ArgumentRuleSchema) }).nullable(),
});
export type AgentTool = z.infer<typeof AgentToolSchema>;
export const AgentToolsSchema = z.object({ agentId: z.string(), tools: z.array(AgentToolSchema) });

export const QueueSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']),
  autoAssignAfterSeconds: z.number().nullable(),
  acceptTimeoutSeconds: z.number(),
  strategy: z.string(),
  requiredSkills: z.array(z.string()),
  languages: z.array(z.string()),
  preferAccountOwner: z.boolean(),
  slaPolicyId: z.string().nullable(),
  afterHoursMessage: z.string().nullable(),
  teamIds: z.array(z.string()),
  waiting: z.number(),
  onShift: z.number(),
  members: z.number(),
  breaches: z.number(),
});
export type Queue = z.infer<typeof QueueSchema>;

export const SlaPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  firstHumanResponseSeconds: z.number(),
  pickupSecondsByPriority: z.record(z.string(), z.number()),
  resolutionSecondsByType: z.record(z.string(), z.number()),
  atRiskFraction: z.number(),
});
export type SlaPolicy = z.infer<typeof SlaPolicySchema>;

export const AgentAlertSchema = z.object({
  id: z.string(),
  kind: z.string(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
  title: z.string(),
  body: z.string(),
  value: z.string().nullable(),
  audienceRoles: z.array(z.string()),
  openedAt: z.string(),
  occurrences: z.number(),
});
export type AgentAlert = z.infer<typeof AgentAlertSchema>;
export const AlertPageSchema = z.object({ items: z.array(AgentAlertSchema), nextCursor: z.string().nullable() });
