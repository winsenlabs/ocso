import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { users } from './identity.js';
import { virtualAgents } from './agents.js';
import { routers } from './routers.js';

/** Canonical external person/account (docs/03 Customer). */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    displayName: text(),
    externalRef: text(),
    language: text(),
    attributes: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    accountOwnerUserId: uuid().references(() => users.id),
    /** Bumped on material context change → turn-cache invalidation. */
    contextVersion: integer().notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('customers_external_ref_uq').on(t.externalRef)],
);

/** Channel-specific identity → Customer. Resolution is deterministic by (kind, value). */
export const customerIdentities = pgTable(
  'customer_identities',
  {
    id: id(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    value: text().notNull(),
    verified: boolean().notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('customer_identities_kind_value_uq').on(t.kind, t.value), index('customer_identities_customer_idx').on(t.customerId)],
);

/** Channel adapter instance (e.g. one WhatsApp number, one web-chat widget). */
export const channels = pgTable(
  'channels',
  {
    id: id(),
    /** A registered channel adapter kind (open: the @ocso/channels registry validates; text so plugins add kinds without a migration). */
    kind: text().notNull(),
    name: text().notNull(),
    status: text().$type<'ACTIVE' | 'DISABLED' | 'DRAFT'>().notNull().default('DRAFT'),
    /** Public, unguessable key used in widget/webhook URLs. */
    publicKey: text().notNull(),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    secretRefs: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Deprecated (PM/research/11 §5): no longer read or written; the router decides. Dropped in a later release. */
    defaultAgentId: uuid().references(() => virtualAgents.id),
    /** Who routes this channel's customers (ACTIVE router only; none = messages are rejected `no_router`). */
    routerId: uuid().references(() => routers.id, { onDelete: 'set null' }),
    lastInboundAt: ts('last_inbound_at'),
    lastVerifiedAt: ts('last_verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('channels_public_key_uq').on(t.publicKey)],
);

/** Deprecated (PM/research/11 §5): no longer read or written; reach is derived through routers and queues. */
export const agentChannels = pgTable(
  'agent_channels',
  {
    agentId: uuid()
      .notNull()
      .references(() => virtualAgents.id, { onDelete: 'cascade' }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
  },
  // One agent per channel (a channel routes to exactly one agent); an agent may answer on many channels.
  (t) => [primaryKey({ columns: [t.agentId, t.channelId] }), uniqueIndex('agent_channels_channel_uq').on(t.channelId)],
);
