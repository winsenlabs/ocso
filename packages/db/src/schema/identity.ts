import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    role: text().$type<'PLATFORM_TECH_ADMIN' | 'CS_LEAD' | 'CS_EXEC'>().notNull(),
    status: text().$type<'ACTIVE' | 'DISABLED'>().notNull().default('ACTIVE'),
    passwordHash: text(),
    availability: text().$type<'AVAILABLE' | 'AWAY' | 'OFFLINE'>().notNull().default('OFFLINE'),
    maxConcurrent: integer().notNull().default(8),
    languages: text().array().notNull().default(sql`'{}'::text[]`),
    skills: text().array().notNull().default(sql`'{}'::text[]`),
    lastAssignedAt: ts('last_assigned_at'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    tokenHash: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    idleExpiresAt: ts('idle_expires_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ip: text(),
    userAgent: text(),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: id(),
    email: text().notNull(),
    ip: text(),
    success: boolean().notNull(),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('login_attempts_email_idx').on(sql`lower(${t.email})`, t.occurredAt), index('login_attempts_ip_idx').on(t.ip, t.occurredAt)],
);

export const teams = pgTable(
  'teams',
  {
    id: id(),
    name: text().notNull(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('teams_name_uq').on(sql`lower(${t.name})`)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index('team_members_user_idx').on(t.userId)],
);
