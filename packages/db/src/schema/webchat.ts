import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts } from './columns.js';
import { channels, customers } from './customers.js';

/**
 * Verified end-user tokens of embeddable channels whose tool identity is
 * `passthrough` (0032): AES-256-GCM ciphertext under a key derived from the
 * channel's secret key, kept only until the token's own `exp` (at most 24 h).
 * Agent tool calls forward the latest live token to connections that opt in.
 */
export const webchatUserTokens = pgTable(
  'webchat_user_tokens',
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    visitorId: text(),
    tokenCiphertext: text().notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('webchat_user_tokens_customer_idx').on(t.customerId, t.channelId, t.expiresAt), index('webchat_user_tokens_expires_idx').on(t.expiresAt)],
);

/** Session-pass ids already exchanged (single use), kept until the pass would have expired anyway. */
export const webchatSessionPassUses = pgTable(
  'webchat_session_pass_uses',
  {
    jti: text().primaryKey(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('webchat_session_pass_uses_expires_idx').on(t.expiresAt)],
);
