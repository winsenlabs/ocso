import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** Shared column helpers so every table follows the same conventions. */
export const id = () => uuid('id').primaryKey();
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => ts('created_at').notNull().defaultNow();
export const updatedAt = () => ts('updated_at').notNull().defaultNow();
