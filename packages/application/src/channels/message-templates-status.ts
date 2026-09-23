import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { TemplateCategory, TemplateStatus } from '@ocso/domain';
import { messageTemplates, type Db, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { systemActor, type ActorContext } from '../shared/context.js';
import { TEMPLATES_CONFIG_AREA, type TemplateProviderSource } from './message-templates.js';
import type { TemplateRow } from './message-templates-view.js';

export interface TemplateStatusChange {
  status: TemplateStatus;
  reason: string | null;
  category?: TemplateCategory | null | undefined;
}

/**
 * Record a provider review result for an OCSO-submitted template. A change
 * is audited and announced: `message_template.status_changed` (the
 * submitter's in-app notice) and `config.changed` (template lists refresh).
 * Returns true when the status or reason changed.
 */
export async function applyTemplateStatus(db: Db, actor: ActorContext, row: TemplateRow, change: TemplateStatusChange, now: Date): Promise<boolean> {
  const reason = change.status === 'REJECTED' || change.status === 'PAUSED' || change.status === 'DISABLED' ? change.reason : null;
  const category = change.category ?? row.category;
  if (change.status === row.status && reason === row.rejectionReason && category === row.category) {
    await db.update(messageTemplates).set({ statusCheckedAt: now }).where(eq(messageTemplates.id, row.id));
    return false;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(messageTemplates)
      .set({ status: change.status, rejectionReason: reason, category, statusCheckedAt: now, statusChangedAt: now, updatedAt: now })
      .where(eq(messageTemplates.id, row.id));
    await recordAudit(tx, actor, {
      action: 'message_template.status_changed',
      targetType: 'message_template',
      targetId: row.id,
      summary: `Message template ${row.name} (${row.language}): ${row.status} → ${change.status}${reason ? ` · ${reason}` : ''}`,
      before: { status: row.status, rejectionReason: row.rejectionReason, category: row.category },
      after: { status: change.status, rejectionReason: reason, category },
    });
    await announce(tx, actor, row, change.status);
  });
  return true;
}

async function announce(tx: DbOrTx, actor: ActorContext, row: TemplateRow, status: TemplateStatus): Promise<void> {
  await emitEvent(tx, actor, 'message_template.status_changed', {
    templateId: row.providerTemplateId ?? row.id,
    channelId: row.channelId,
    name: row.name,
    language: row.language,
    status,
    previousStatus: row.status,
    submittedBy: row.submittedBy,
  });
  await emitEvent(tx, actor, 'config.changed', { area: TEMPLATES_CONFIG_AREA, entityId: row.channelId });
}

/**
 * Leader task (worker): ask the provider about templates still in review.
 * Oldest-checked first, bounded per run; provider errors skip a template
 * until the next run. Idempotent.
 */
export async function pollPendingTemplates(
  db: Db,
  providers: TemplateProviderSource,
  options: { correlationId: string; now?: () => Date; limit?: number },
): Promise<{ checked: number; changed: number; failed: number }> {
  const now = options.now ?? (() => new Date());
  const rows = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.status, 'PENDING'), isNull(messageTemplates.deletedAt), isNotNull(messageTemplates.providerTemplateId)))
    .orderBy(sql`${messageTemplates.statusCheckedAt} ASC NULLS FIRST`, asc(messageTemplates.submittedAt))
    .limit(options.limit ?? 50);
  const actor = systemActor('template-status-poller', options.correlationId, 'Template status poller');
  const result = { checked: 0, changed: 0, failed: 0 };
  for (const row of rows) {
    try {
      const port = await providers(row.channelId);
      if (!port.templateStatus) continue;
      const current = await port.templateStatus(row.providerTemplateId!);
      result.checked++;
      const change: TemplateStatusChange = current
        ? { status: current.status, reason: current.rejectionReason, category: current.category }
        : { status: 'DISABLED', reason: 'The provider no longer has this template' };
      if (await applyTemplateStatus(db, actor, row, change, now())) result.changed++;
    } catch {
      // Provider down or credentials changed: retried on the next run.
      result.failed++;
    }
  }
  return result;
}

/** A provider-pushed review result (`InboundEnvelope.templateUpdates`); unknown templates are ignored. */
export async function applyProviderTemplateUpdate(
  db: Db,
  channelId: string,
  update: { templateId: string; status: TemplateStatus; reason: string | null },
  options: { correlationId: string; now?: Date },
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.channelId, channelId), eq(messageTemplates.providerTemplateId, update.templateId), isNull(messageTemplates.deletedAt)));
  if (!row) return false;
  const actor = systemActor('provider-webhook', options.correlationId, 'Channel webhook');
  return applyTemplateStatus(db, actor, row, { status: update.status, reason: update.reason }, options.now ?? new Date());
}
