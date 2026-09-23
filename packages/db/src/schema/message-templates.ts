import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, ts, updatedAt } from './columns.js';
import { channels } from './customers.js';
import { users } from './identity.js';

/**
 * Message templates created in OCSO and submitted to the channel's provider
 * for review (docs/07 §3; any kind whose adapter implements the template
 * methods). The provider stays the source of truth for what can be sent; this
 * keeps OCSO's own history (who submitted what, when, and every status
 * change) even before or after the provider lists the template.
 * Renamed from `whatsapp_templates` in migration 0019.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** The provider's template id (e.g. a Twilio Content SID or a Meta template id); null while an OCSO draft (0027). */
    providerTemplateId: text(),
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
    /**
     * OCSO: drafted here and submitted through an approval (PM/research/11 §4). PROVIDER: made in the provider's
     * console, recorded only when a deletion was proposed from OCSO (0027).
     */
    origin: text().$type<'OCSO' | 'PROVIDER'>().notNull().default('OCSO'),
    /** Deleted at the provider through OCSO (kept for history). */
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('message_templates_provider_uq').on(t.channelId, t.providerTemplateId),
    uniqueIndex('message_templates_name_uq').on(t.channelId, t.name, t.language).where(sql`${t.deletedAt} IS NULL`),
    index('message_templates_pending_idx').on(t.status).where(sql`${t.status} = 'PENDING' AND ${t.deletedAt} IS NULL`),
    check('message_templates_origin_ck', sql`${t.origin} IN ('OCSO', 'PROVIDER')`),
    check('message_templates_provider_id_ck', sql`${t.providerTemplateId} IS NOT NULL OR (${t.status} = 'DRAFT' AND ${t.origin} = 'OCSO')`),
  ],
);
