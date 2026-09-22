import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { channels } from './customers.js';
import { users } from './identity.js';

/**
 * WhatsApp templates created in OCSO and submitted to the provider for
 * approval (docs/07 §3). The provider stays the source of truth for what can
 * be sent; this keeps OCSO's own history (who submitted what, when, and every
 * status change) even before or after the provider lists the template.
 */
export const whatsappTemplates = pgTable(
  'whatsapp_templates',
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** Twilio Content SID (HX…) or Meta template id. */
    providerTemplateId: text().notNull(),
    name: text().notNull(),
    language: text().notNull(),
    /** UTILITY | MARKETING | AUTHENTICATION (the provider may re-categorize). */
    category: text().notNull(),
    /** DRAFT | PENDING | APPROVED | REJECTED | PAUSED | DISABLED (normalized). */
    status: text().notNull(),
    rejectionReason: text(),
    /** The TemplateDraft as submitted (header, body, footer, buttons, examples). */
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    submittedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    submittedAt: ts('submitted_at').notNull().defaultNow(),
    statusCheckedAt: ts('status_checked_at'),
    statusChangedAt: ts('status_changed_at'),
    /** Deleted at the provider through OCSO (kept for history). */
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('whatsapp_templates_provider_uq').on(t.channelId, t.providerTemplateId),
    uniqueIndex('whatsapp_templates_name_uq').on(t.channelId, t.name, t.language).where(sql`${t.deletedAt} IS NULL`),
    index('whatsapp_templates_pending_idx').on(t.status).where(sql`${t.status} = 'PENDING' AND ${t.deletedAt} IS NULL`),
  ],
);
