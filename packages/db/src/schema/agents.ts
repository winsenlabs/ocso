import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';
import { modelProfiles } from './models.js';
import { queues } from './routing.js';

export interface MultimodalSettings {
  imageInput: boolean;
  documentInput: boolean;
  audioInput: boolean;
  maxMediaPerTurn: number;
}

export interface BusinessHours {
  timezone: string;
  /** e.g. { mon: ['08:00','23:00'] } ; empty = 24×7 for humans */
  humanHours: Record<string, [string, string]>;
}

/** Named AI employee — a logical entity, never a worker (build rule §6). */
export const virtualAgents = pgTable(
  'virtual_agents',
  {
    id: id(),
    name: text().notNull(),
    slug: text().notNull(),
    purpose: text().notNull().default(''),
    conversationType: text().$type<'SUPPORT' | 'SALES' | 'COLLECTIONS' | 'ONBOARDING' | 'CUSTOM'>().notNull(),
    description: text().notNull().default(''),
    status: text().$type<'DRAFT' | 'LIVE' | 'PAUSED'>().notNull().default('DRAFT'),
    activePromptVersionId: uuid(),
    modelProfileId: uuid().references(() => modelProfiles.id),
    summarizerProfileId: uuid().references(() => modelProfiles.id),
    copilotProfileId: uuid().references(() => modelProfiles.id),
    defaultQueueId: uuid().references(() => queues.id),
    multimodal: jsonb().$type<MultimodalSettings>().notNull().default({
      imageInput: true,
      documentInput: true,
      audioInput: false,
      maxMediaPerTurn: 4,
    }),
    businessHours: jsonb().$type<BusinessHours>().notNull().default({ timezone: 'UTC', humanHours: {} }),
    midTurnPolicy: text().$type<'QUEUE_BEHIND' | 'CANCEL_AND_RESTART'>().notNull().default('QUEUE_BEHIND'),
    maxToolSteps: integer().notNull().default(6),
    copilotEnabled: boolean().notNull().default(true),
    avatarTone: text().notNull().default('indigo'),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('virtual_agents_slug_uq').on(t.slug)],
);

/** Immutable prompt version (docs/05 §2). Never updated after insert except activation stamps. */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => virtualAgents.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    components: jsonb().$type<Record<string, string>>().notNull(),
    componentHashes: jsonb().$type<Record<string, string>>().notNull(),
    promptHash: text().notNull(),
    runtimeContractVersion: text().notNull(),
    changedComponents: text().array().notNull(),
    parentVersionId: uuid(),
    reason: text().notNull(),
    authorId: uuid().references(() => users.id),
    correctionIds: uuid().array(),
    evaluationRunId: uuid(),
    createdAt: createdAt(),
    firstActivatedAt: ts('first_activated_at'),
  },
  (t) => [uniqueIndex('prompt_versions_agent_version_uq').on(t.agentId, t.version)],
);

/** One mutable working draft per agent; creating a version snapshots it. */
export const promptDrafts = pgTable('prompt_drafts', {
  agentId: uuid()
    .primaryKey()
    .references(() => virtualAgents.id, { onDelete: 'cascade' }),
  components: jsonb().$type<Record<string, string>>().notNull(),
  baseVersionId: uuid(),
  updatedBy: uuid().references(() => users.id),
  updatedAt: updatedAt(),
});

export const promptCorrections = pgTable(
  'prompt_corrections',
  {
    id: id(),
    agentId: uuid()
      .notNull()
      .references(() => virtualAgents.id, { onDelete: 'cascade' }),
    conversationId: uuid(),
    interactionSeq: integer(),
    title: text().notNull(),
    observed: text().notNull(),
    desired: text().notNull(),
    componentKey: text().notNull(),
    proposedText: text(),
    status: text().$type<'OPEN' | 'STAGED' | 'APPLIED' | 'REJECTED'>().notNull().default('OPEN'),
    source: text().$type<'LEAD' | 'INSIGHTS' | 'INTERNAL_AGENT'>().notNull().default('LEAD'),
    occurrences: integer().notNull().default(1),
    resultingVersionId: uuid(),
    createdBy: uuid().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('prompt_corrections_agent_idx').on(t.agentId, t.status)],
);

export interface ArgumentRuleColumn {
  path: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'in' | 'not_in' | 'exists';
  value?: unknown;
  effect: 'REQUIRE_CONFIRMATION' | 'DENY';
  message: string;
}

/** CS Lead enables specific approved tools per agent, with argument policy rules. */
export const agentToolGrants = pgTable(
  'agent_tool_grants',
  {
    agentId: uuid()
      .notNull()
      .references(() => virtualAgents.id, { onDelete: 'cascade' }),
    toolId: uuid().notNull(),
    enabled: boolean().notNull().default(true),
    alwaysConfirm: boolean().notNull().default(false),
    argumentRules: jsonb().$type<ArgumentRuleColumn[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.toolId] })],
);

export const escalationRules = pgTable(
  'escalation_rules',
  {
    id: id(),
    /** null = platform-wide rule. */
    agentId: uuid().references(() => virtualAgents.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    trigger: text().notNull(),
    condition: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    mode: text().$type<'AUTO_ASSIGN' | 'OPEN_PICKUP'>().notNull().default('OPEN_PICKUP'),
    targetQueueId: uuid().references(() => queues.id),
    priority: text().$type<'P1' | 'P2' | 'P3' | 'P4'>().notNull().default('P3'),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('escalation_rules_agent_idx').on(t.agentId)],
);
