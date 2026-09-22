import { integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
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
