import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './columns.js';
import { teams } from './identity.js';
import { virtualAgents, type BusinessHours } from './agents.js';

export const slaPolicies = pgTable('sla_policies', {
  id: id(),
  name: text().notNull(),
  firstHumanResponseSeconds: integer().notNull().default(900),
  pickupSecondsByPriority: jsonb().$type<Partial<Record<'P1' | 'P2' | 'P3' | 'P4', number>>>().notNull().default({}),
  resolutionSecondsByType: jsonb().$type<Record<string, number>>().notNull().default({}),
  atRiskFraction: real().notNull().default(0.75),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Business queue with eligibility and pickup/assignment policy (docs/03 Queue). */
export const queues = pgTable(
  'queues',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    mode: text().$type<'AUTO_ASSIGN' | 'OPEN_PICKUP'>().notNull().default('OPEN_PICKUP'),
    /** OPEN_PICKUP: auto-assign after this many seconds unclaimed (null = never). */
    autoAssignAfterSeconds: integer(),
    /** AUTO_ASSIGN: seconds an assignee has to accept before reassignment. */
    acceptTimeoutSeconds: integer().notNull().default(120),
    strategy: text().$type<'LEAST_ACTIVE'>().notNull().default('LEAST_ACTIVE'),
    requiredSkills: text().array().notNull().default(sql`'{}'::text[]`),
    languages: text().array().notNull().default(sql`'{}'::text[]`),
    preferAccountOwner: boolean().notNull().default(true),
    slaPolicyId: uuid().references(() => slaPolicies.id),
    afterHoursMessage: text(),
    /** The queue's one AI agent (PM/research/11 §5.5); an agent may serve many queues. */
    // Annotated: agents.ts references queues too (default_queue_id), a type-level cycle.
    agentId: uuid().references((): AnyPgColumn => virtualAgents.id, { onDelete: 'set null' }),
    /** What the queue serves, e.g. { language: 'ta', product: 'sales' }; unique across queues when set. */
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** When humans take handoffs from this queue; null = the agent's hours. */
    businessHours: jsonb().$type<BusinessHours | null>(),
    /** Queues conversations may be transferred to from here (by the AI tool; humans see them first). */
    transferTargetIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('queues_name_uq').on(sql`lower(${t.name})`),
    uniqueIndex('queues_attributes_uq').on(t.attributes).where(sql`${t.attributes} <> '{}'::jsonb`),
    index('queues_agent_idx').on(t.agentId),
  ],
);

export const queueTeams = pgTable(
  'queue_teams',
  {
    queueId: uuid()
      .notNull()
      .references(() => queues.id, { onDelete: 'cascade' }),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.queueId, t.teamId] }), index('queue_teams_team_idx').on(t.teamId)],
);
