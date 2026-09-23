import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { TemplateDraftSchema, checkTemplateDraft, conflict, notFound, validation, type DraftIssue, type MessageTemplate, type TemplateDraft } from '@ocso/domain';
import { approvalProposals, messageTemplates, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { assertUnlocked, lockObject } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { loadManageableChannel, type ChannelRow } from './message-templates-access.js';
import type { TemplateApprovalRef, TemplateRow } from './message-templates-view.js';

/**
 * Message templates as maker–checker objects (PM/research/11 §4): a template is
 * saved in OCSO as a DRAFT the provider has never seen, edited freely while it
 * is one, and submitted to the provider only by an approved `message_template`
 * CREATE proposal (message-template-approval.ts). Deleting one is always a
 * proposal too (message_templates.delete, Head).
 */

export const TEMPLATE_KIND = 'message_template';
/** `config.changed` area announced when a channel's templates change (template lists refresh). */
export const TEMPLATES_CONFIG_AREA = 'message_templates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Open (or approved, still activating) proposals per template record: the list shows them on each row. */
export async function templateApprovals(db: DbOrTx, recordIds: readonly string[]): Promise<Map<string, TemplateApprovalRef>> {
  const out = new Map<string, TemplateApprovalRef>();
  if (!recordIds.length) return out;
  const rows = await db
    .select({ id: approvalProposals.id, objectId: approvalProposals.objectId, action: approvalProposals.action, status: approvalProposals.status, checkerName: users.name })
    .from(approvalProposals)
    .leftJoin(users, eq(users.id, approvalProposals.checkerId))
    .where(
      and(
        eq(approvalProposals.objectKind, TEMPLATE_KIND),
        inArray(approvalProposals.objectId, [...recordIds]),
        or(eq(approvalProposals.status, 'SUBMITTED'), and(eq(approvalProposals.status, 'APPROVED'), eq(approvalProposals.origin, 'USER'), isNull(approvalProposals.activatedAt))),
      ),
    );
  for (const r of rows) {
    if (r.action !== 'CREATE' && r.action !== 'DELETE') continue;
    out.set(r.objectId, { proposalId: r.id, action: r.action, checkerName: r.checkerName, activating: r.status === 'APPROVED' });
  }
  return out;
}

/** The approval lock of one template (the descriptor's default key), then its row. */
export async function lockTemplate(tx: DbOrTx, recordId: string): Promise<TemplateRow | null> {
  await lockObject(tx, `${TEMPLATE_KIND}:${recordId}`);
  const [row] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, recordId)).for('update');
  return row ?? null;
}

/** A live (not deleted) row of the channel, by provider template id or — for drafts — OCSO record id. */
export async function templateRowOf(db: DbOrTx, channelId: string, templateId: string): Promise<TemplateRow | null> {
  const byRecord = UUID.test(templateId) ? eq(messageTemplates.id, templateId) : undefined;
  const [row] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.channelId, channelId), isNull(messageTemplates.deletedAt), or(eq(messageTemplates.providerTemplateId, templateId), byRecord)));
  return row ?? null;
}

export interface DraftResult {
  row: TemplateRow;
  /** What the provider would reject: the draft cannot be submitted until these are fixed. */
  problems: DraftIssue[];
  warnings: DraftIssue[];
}

function parseDraft(input: unknown): { draft: TemplateDraft; problems: DraftIssue[]; warnings: DraftIssue[] } {
  const draft = TemplateDraftSchema.parse(input);
  if (!draft.name || !draft.language) throw validation('invalid_template', 'Give the template a name and a language');
  const check = checkTemplateDraft(draft);
  return { draft, problems: check.problems, warnings: check.warnings };
}

async function assertNameFree(tx: DbOrTx, channelId: string, draft: TemplateDraft, except: string | null): Promise<void> {
  const rows = await tx
    .select({ id: messageTemplates.id })
    .from(messageTemplates)
    .where(and(eq(messageTemplates.channelId, channelId), eq(messageTemplates.name, draft.name), eq(messageTemplates.language, draft.language), isNull(messageTemplates.deletedAt)));
  if (rows.some((r) => r.id !== except)) throw conflict('template_exists', `${draft.name} (${draft.language}) already exists in OCSO on this channel`);
}

/** Save a new draft (message_templates.manage, a channel of the maker's teams). Never sent to the provider here. */
export async function createTemplateDraft(db: Db, actor: ActorContext, channel: ChannelRow, input: unknown): Promise<DraftResult> {
  const principal = actor.principal as Principal;
  const { draft, problems, warnings } = parseDraft(input);
  const id = uuidv7();
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    await assertNameFree(tx, channel.id, draft, null);
    const [inserted] = await tx
      .insert(messageTemplates)
      .values({
        id,
        channelId: channel.id,
        providerTemplateId: null,
        origin: 'OCSO',
        name: draft.name,
        language: draft.language,
        category: draft.category,
        status: 'DRAFT',
        rejectionReason: null,
        definition: draft as unknown as Record<string, unknown>,
        submittedBy: principal.userId,
        submittedAt: now,
      })
      .returning();
    await recordAudit(tx, actor, {
      action: 'message_template.create',
      targetType: TEMPLATE_KIND,
      targetId: id,
      summary: `Drafted message template ${draft.name} (${draft.language}) on ${channel.name}; the provider sees it once approved`,
      after: { ...draft, status: 'DRAFT' },
    });
    await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: channel.id });
    return inserted!;
  });
  return { row, problems, warnings };
}

/** Edit a draft the provider has never seen. Locked while its submission waits for approval (409 approval_open). */
export async function updateTemplateDraft(db: Db, actor: ActorContext, channel: ChannelRow, recordId: string, input: unknown): Promise<DraftResult> {
  const { draft, problems, warnings } = parseDraft(input);
  const row = await db.transaction(async (tx) => {
    const before = await lockTemplate(tx, recordId);
    if (!before || before.channelId !== channel.id || before.deletedAt) throw notFound('template', recordId);
    if (before.providerTemplateId !== null) throw conflict('template_submitted', 'This template is at the provider already and cannot be edited: draft a new one instead');
    await assertUnlocked(tx, { kind: TEMPLATE_KIND }, recordId);
    await assertNameFree(tx, channel.id, draft, recordId);
    const [updated] = await tx
      .update(messageTemplates)
      .set({ name: draft.name, language: draft.language, category: draft.category, definition: draft as unknown as Record<string, unknown>, rejectionReason: null, updatedAt: new Date() })
      .where(eq(messageTemplates.id, recordId))
      .returning();
    await recordAudit(tx, actor, {
      action: 'message_template.update',
      targetType: TEMPLATE_KIND,
      targetId: recordId,
      summary: `Edited draft message template ${draft.name} (${draft.language}) on ${channel.name}`,
      before: before.definition,
      after: draft,
    });
    await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: channel.id });
    return updated!;
  });
  return { row, problems, warnings };
}

/**
 * The record a deletion proposal points at. A template made in the provider's
 * console has no OCSO row yet: it is recorded (origin PROVIDER, idempotent) so
 * the proposal has an object. Scoped like every template write.
 */
export async function deletionTarget(db: Db, principal: Principal, channelId: string, templateId: string, fromProvider: () => Promise<MessageTemplate | null>): Promise<TemplateRow> {
  const channel = await loadManageableChannel(db, principal, channelId);
  const existing = await templateRowOf(db, channel.id, templateId);
  if (existing) return existing;
  const template = await fromProvider();
  if (!template) throw notFound('template', templateId);
  await db
    .insert(messageTemplates)
    .values({
      id: uuidv7(),
      channelId: channel.id,
      providerTemplateId: template.id,
      origin: 'PROVIDER',
      name: template.name,
      language: template.language,
      category: template.category ?? 'UTILITY',
      status: template.status,
      rejectionReason: template.rejectionReason,
      definition: providerDefinition(template),
      submittedBy: null,
    })
    .onConflictDoNothing();
  const row = await templateRowOf(db, channel.id, template.id);
  if (!row) throw conflict('template_exists', `${template.name} (${template.language}) clashes with a template recorded in OCSO`);
  return row;
}

/** A provider template as the draft shape OCSO stores (enough to show it and to address it for deletion). */
function providerDefinition(t: MessageTemplate): Record<string, unknown> {
  const header = t.header?.format === 'TEXT' ? { format: 'TEXT', text: t.header.text ?? '' } : null;
  const buttons: Array<Record<string, string>> = t.buttons.flatMap((b): Array<Record<string, string>> =>
    b.type === 'QUICK_REPLY' ? [{ type: b.type, text: b.text }] : b.type === 'URL' ? [{ type: b.type, text: b.text, url: b.url ?? '' }] : b.type === 'PHONE_NUMBER' ? [{ type: b.type, text: b.text, phone: b.phone ?? '' }] : [],
  );
  const draft = TemplateDraftSchema.parse({ name: t.name, language: t.language, category: t.category ?? 'UTILITY', header, body: t.body, footer: t.footer, buttons });
  return { ...draft, placeholderScope: t.placeholderScope };
}
