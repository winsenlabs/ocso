import { sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';

/**
 * Secret metadata for both drivers (ADR-012). Local driver: `ciphertext` holds
 * AES-256-GCM output. AWS driver: `externalId` holds the Secrets Manager ARN.
 */
export const secrets = pgTable('secrets', {
  ref: text().primaryKey(),
  name: text().notNull(),
  kind: text().notNull(),
  usedBy: text(),
  ciphertext: jsonb().$type<{ keyId: string; iv: string; tag: string; data: string }>(),
  externalId: text(),
  version: integer().notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  rotatedAt: ts('rotated_at'),
  expiresAt: ts('expires_at'),
});

/**
 * Asymmetric signing keys (customer identity claims, docs/archive/specs/08 §4). The private
 * key lives in the SecretStore; only the public JWK is stored here. RETIRING
 * keys stay in the JWKS so recently issued tokens still verify.
 */
export const signingKeys = pgTable(
  'signing_keys',
  {
  kid: text().primaryKey(),
  purpose: text().$type<'customer_claims'>().notNull(),
  alg: text().$type<'ES256'>().notNull(),
  publicJwk: jsonb().$type<Record<string, string>>().notNull(),
  privateKeyRef: text().notNull(),
  status: text().$type<'ACTIVE' | 'RETIRING' | 'RETIRED'>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  retiringAt: ts('retiring_at'),
  retiredAt: ts('retired_at'),
  },
  // At most one active key per purpose.
  (t) => [uniqueIndex('signing_keys_one_active_uq').on(t.purpose).where(sql`${t.status} = 'ACTIVE'`)],
);
