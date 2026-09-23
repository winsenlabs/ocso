import { and, eq, isNotNull } from 'drizzle-orm';
import { DomainError, ErrorCategory, TemplateDraftSchema, draftAsTemplate, isDomainError, validation, type MessageTemplate, type TemplateDraft } from '@ocso/domain';
import { messageTemplates, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { TEMPLATE_KIND, TEMPLATES_CONFIG_AREA } from './message-template-drafts.js';
import { loadChannel } from './message-templates-access.js';
import type { TemplateProviderSource } from './message-templates.js';
import type { TemplateRow } from './message-templates-view.js';

/**
 * The provider half of an approved template proposal (DEFERRED activation,
 * PM/research/11b): run by the worker after the spine re-validated and
 * re-checked both hashes, one runner per proposal. Idempotent: a row that
 * already carries a provider id is never created again, and a retry after a
 * crash first looks the draft up at the provider by name and language, so the
 * provider is never asked to create the same template twice. Only a listed
 * template with exactly the approved content is adopted: one with the same name
 * and other content (made in the provider's console) blocks the proposal, and a
 * listing that fails is retried, never answered with a second create.
 */

/** What a customer receives: header, body, footer and buttons as the provider would build them from the draft. */
function customerContent(t: Pick<MessageTemplate, 'header' | 'body' | 'footer' | 'buttons'>): string {
  const header = t.header ? { format: t.header.format, text: t.header.text ?? null, mediaUrl: t.header.mediaUrl ?? null } : null;
  const buttons = t.buttons.map((b) => ({ type: b.type, text: b.text, url: b.url ?? null, phone: b.phone ?? null }));
  return JSON.stringify({ header, body: t.body, footer: t.footer ?? null, buttons });
}

/** Whether a listed provider template is the approved draft (same name, language and customer-visible content). */
export function isApprovedDraftAtProvider(draft: TemplateDraft, listed: MessageTemplate): boolean {
  if (listed.name !== draft.name || listed.language !== draft.language) return false;
  return customerContent(listed) === customerContent(draftAsTemplate(draft, { id: listed.id, status: listed.status, scope: listed.placeholderScope }));
}

/** An earlier attempt's template at the provider, if one reached it; throws (retriable) when the provider cannot be asked. */
async function earlierSubmission(db: Db, list: () => Promise<MessageTemplate[]>, row: TemplateRow, draft: TemplateDraft): Promise<MessageTemplate | undefined> {
  const listed = await list().catch((err: unknown) => {
    // Retriable: the worker tries again (and blocks after its last attempt) rather than risk a second create.
    throw new DomainError(ErrorCategory.PROVIDER_UNAVAILABLE, 'template_lookup_failed', `Could not check the provider for an earlier submission: ${err instanceof Error ? err.message : 'unknown error'}`);
  });
  const sameName = listed.filter((t) => t.name === draft.name && t.language === draft.language);
  if (!sameName.length) return undefined;
  const known = new Set(
    (await db.select({ id: messageTemplates.providerTemplateId }).from(messageTemplates).where(and(eq(messageTemplates.channelId, row.channelId), isNotNull(messageTemplates.providerTemplateId)))).map((r) => r.id),
  );
  const ours = sameName.find((t) => !known.has(t.id) && isApprovedDraftAtProvider(draft, t));
  if (ours) return ours;
  throw validation('template_name_taken', `The provider already has a template named ${draft.name} (${draft.language}) with other content; it was not adopted. Rename the draft and submit it again.`);
}

async function current(db: Db, recordId: string): Promise<TemplateRow> {
  const [row] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, recordId));
  if (!row) throw validation('object_missing', 'The template no longer exists');
  return row;
}

/** Submit an approved draft to the channel's provider for review, and record the provider's id and status. */
export async function submitDraftToProvider(db: Db, providers: TemplateProviderSource, actor: ActorContext, recordId: string): Promise<void> {
  const row = await current(db, recordId);
  if (row.deletedAt) throw validation('object_missing', 'The template was deleted');
  if (row.providerTemplateId) return;
  const channel = await loadChannel(db, row.channelId);
  const port = await providers(channel.id);
  if (!port.createTemplate) throw validation('templates_unsupported', `${channel.name} cannot create message templates`);
  const draft = TemplateDraftSchema.parse(row.definition);
  // A previous attempt may have reached the provider before it crashed: adopt that template instead of creating a
  // second. Looked up on every attempt (an attempt's crash may predate its counter), never skipped on a failed listing.
  const earlier = port.listTemplates ? await earlierSubmission(db, port.listTemplates, row, draft) : undefined;
  const created = earlier ?? (await port.createTemplate(draft));
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(messageTemplates)
      .set({
        providerTemplateId: created.id,
        status: created.status,
        category: created.category ?? draft.category,
        rejectionReason: created.rejectionReason,
        definition: { ...draft, placeholderScope: created.placeholderScope } as unknown as Record<string, unknown>,
        submittedAt: now,
        statusCheckedAt: now,
        statusChangedAt: now,
        updatedAt: now,
      })
      .where(eq(messageTemplates.id, recordId));
    await recordAudit(tx, actor, {
      action: 'message_template.submit',
      targetType: TEMPLATE_KIND,
      targetId: recordId,
      summary: `Submitted ${draft.name} (${draft.language}) to ${channel.name} for review as ${draft.category} (approved)`,
      after: { providerTemplateId: created.id, status: created.status },
    });
    await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: channel.id });
  });
}

/** Delete an approved template at the provider (a provider that no longer has it counts as done), then record it. */
export async function deleteTemplateAtProvider(db: Db, providers: TemplateProviderSource, actor: ActorContext, recordId: string): Promise<void> {
  const row = await current(db, recordId);
  if (row.deletedAt) return;
  const channel = await loadChannel(db, row.channelId);
  if (row.providerTemplateId) {
    const port = await providers(channel.id);
    if (!port.deleteTemplate) throw validation('templates_unsupported', `${channel.name} cannot delete message templates`);
    await port.deleteTemplate({ id: row.providerTemplateId, name: row.name }).catch((err: unknown) => {
      // Gone at the provider already: the deletion is done. A refusal (non-retriable) blocks the proposal; an outage retries.
      if (!(isDomainError(err) && err.category === ErrorCategory.NOT_FOUND)) throw err;
    });
  }
  await db.transaction((tx) => markTemplateDeleted(tx, actor, row, channel.name));
}

/** Record a deletion (kept for history), audited and announced. */
export async function markTemplateDeleted(tx: DbOrTx, actor: ActorContext, row: TemplateRow, channelName: string): Promise<void> {
  const now = new Date();
  await tx.update(messageTemplates).set({ deletedAt: now, updatedAt: now }).where(eq(messageTemplates.id, row.id));
  await recordAudit(tx, actor, {
    action: 'message_template.delete',
    targetType: TEMPLATE_KIND,
    targetId: row.id,
    summary: `Deleted message template ${row.name} (${row.language}) from ${channelName} (approved)`,
    before: { providerTemplateId: row.providerTemplateId, name: row.name, status: row.status },
  });
  await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: row.channelId });
}
