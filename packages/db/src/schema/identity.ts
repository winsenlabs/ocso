import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    role: text().$type<'TECH' | 'HEAD' | 'LEAD' | 'SERVICE'>().notNull(),
    /** PENDING_APPROVAL: created, inert and unable to sign in until the user proposal is approved (PM/research/11 §3.4). */
    status: text().$type<'ACTIVE' | 'DISABLED' | 'PENDING_APPROVAL'>().notNull().default('ACTIVE'),
    /** Better Auth fields (ADR-025). An accepted invite or SSO sign-in verifies the address. */
    emailVerified: boolean().notNull().default(false),
    image: text(),
    twoFactorEnabled: boolean().notNull().default(false),
    /** Pending invite: set when an invite link is sent, cleared when it is accepted. */
    invitedAt: ts('invited_at'),
    inviteExpiresAt: ts('invite_expires_at'),
    availability: text().$type<'AVAILABLE' | 'AWAY' | 'OFFLINE'>().notNull().default('OFFLINE'),
    maxConcurrent: integer().notNull().default(8),
    languages: text().array().notNull().default(sql`'{}'::text[]`),
    skills: text().array().notNull().default(sql`'{}'::text[]`),
    lastAssignedAt: ts('last_assigned_at'),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    check('users_status_ck', sql`${t.status} IN ('ACTIVE','DISABLED','PENDING_APPROVAL')`),
  ],
);

/**
 * Sign-in attempts (success and failure) recorded by OCSO's Better Auth policy
 * plugin: per-account throttling and the auth-failure alert (docs/11).
 */
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
