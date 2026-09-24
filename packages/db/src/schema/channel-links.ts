import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns.js';
import { channels } from './customers.js';
import { users } from './identity.js';

/**
 * Ask OCSO over staff chat channels (migration 0036): a chat identity on a channel (the adapter's identity kind and
 * value, e.g. `slack_user` `T…:U…`) linked to one OCSO user, who then asks Ask OCSO from chat as themselves.
 * At most one active link per chat identity per channel; revoked links stay for the record.
 */
export const channelAccountLinks = pgTable(
  'channel_account_links',
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    identityKind: text().notNull(),
    identityValue: text().notNull(),
    /** The chat display name the provider sent when the link was made (account page only). */
    profileName: text(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How the linking session was signed in; the MFA policy is checked against it on every message. */
    authMethod: text().notNull(),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [
    uniqueIndex('channel_account_links_active_uq').on(t.channelId, t.identityKind, t.identityValue).where(sql`${t.revokedAt} IS NULL`),
    index('channel_account_links_user_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * One-time link tokens sent to unknown senders: sha256 only, bound to channel + chat identity, 10 minutes, single use.
 * Confirming on the `/link/<token>` page only claims the token for the signed-in user and shows them a short code;
 * the link is made when that code comes back from the same chat identity (proof the OCSO user holds the chat account).
 */
export const channelLinkTokens = pgTable(
  'channel_link_tokens',
  {
    tokenHash: text().primaryKey(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    identityKind: text().notNull(),
    identityValue: text().notNull(),
    profileName: text(),
    /** Where "Linked." is posted back: the adapter's opaque reply context of the message that asked. */
    replyContext: jsonb().$type<Record<string, string>>(),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    /** The OCSO user who confirmed on the link page and was shown the code; the link is theirs once the code comes back. */
    claimedBy: uuid().references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the code (with the token hash), never the code itself. */
    claimCodeHash: text(),
    /** How the claiming session was signed in (becomes the link's auth method). */
    claimAuthMethod: text(),
    /** Wrong codes sent from the chat identity since the claim; the claim is burned after a few. */
    claimAttempts: integer().notNull().default(0),
  },
  (t) => [index('channel_link_tokens_identity_idx').on(t.channelId, t.identityKind, t.identityValue, t.createdAt)],
);

/** Inbound messages of staff (Ask OCSO) channels: taken once per provider message id, and counted per link for the rate limit. */
export const channelStaffMessages = pgTable(
  'channel_staff_messages',
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    externalMessageId: text().notNull(),
    linkId: uuid().references(() => channelAccountLinks.id, { onDelete: 'set null' }),
    receivedAt: ts('received_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'channel_staff_messages_pk', columns: [t.channelId, t.externalMessageId] }),
    index('channel_staff_messages_link_idx').on(t.linkId, t.receivedAt),
    index('channel_staff_messages_received_idx').on(t.receivedAt),
  ],
);
