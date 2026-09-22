import { and, eq, inArray, isNull } from 'drizzle-orm';
import { TemplateDraftSchema, draftAsTemplate, type MessageTemplate, type TemplateStatus } from '@ocso/domain';
import { users, whatsappTemplates, type DbOrTx } from '@ocso/db';

export type TemplateRow = typeof whatsappTemplates.$inferSelect;

/** OCSO's own record of a template submitted from here. */
export interface TemplateSubmission {
  recordId: string;
  submittedBy: { id: string; name: string } | null;
  submittedAt: string;
  statusChangedAt: string | null;
}

export interface TemplateView extends MessageTemplate {
  /** Present when the template was created in OCSO (history survives the provider list). */
  submission: TemplateSubmission | null;
}

export interface TemplateListView {
  channel: { id: string; kind: string; name: string };
  templates: TemplateView[];
  /** When the provider list was fetched (cached ~5 minutes); null when it could not be fetched. */
  fetchedAt: string | null;
  /** Why the provider list is unavailable (credentials, missing WABA id, provider down). */
  problem: { code: string; message: string } | null;
}

/** OCSO-submitted rows of a channel (not deleted), with the submitter's name. */
export async function submittedRows(db: DbOrTx, channelId: string, providerIds?: readonly string[]): Promise<Array<TemplateRow & { submitterName: string | null }>> {
  const rows = await db
    .select({ t: whatsappTemplates, submitterName: users.name })
    .from(whatsappTemplates)
    .leftJoin(users, eq(users.id, whatsappTemplates.submittedBy))
    .where(
      and(
        eq(whatsappTemplates.channelId, channelId),
        isNull(whatsappTemplates.deletedAt),
        providerIds ? inArray(whatsappTemplates.providerTemplateId, [...providerIds]) : undefined,
      ),
    );
  return rows.map((r) => ({ ...r.t, submitterName: r.submitterName }));
}

function submissionOf(row: TemplateRow & { submitterName: string | null }): TemplateSubmission {
  return {
    recordId: row.id,
    submittedBy: row.submittedBy ? { id: row.submittedBy, name: row.submitterName ?? 'former user' } : null,
    submittedAt: row.submittedAt.toISOString(),
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
  };
}

/** A submitted row as a template, for when the provider has not listed it (yet). */
export function rowAsTemplate(row: TemplateRow): MessageTemplate {
  const draft = TemplateDraftSchema.parse(row.definition);
  // The provider's variable-key scheme is recorded with the submitted definition.
  const scope = row.definition['placeholderScope'] === 'component' ? 'component' : 'template';
  return draftAsTemplate(draft, { id: row.providerTemplateId, status: row.status as TemplateStatus, rejectionReason: row.rejectionReason, scope });
}

/**
 * Provider list + OCSO rows. A row checked after the list was fetched wins
 * the status (the poller may have seen an approval the cached list has not);
 * rows the provider does not list are shown from their submitted definition.
 */
export function mergeTemplates(
  provider: readonly MessageTemplate[],
  rows: ReadonlyArray<TemplateRow & { submitterName: string | null }>,
  fetchedAt: Date | null,
): TemplateView[] {
  const byId = new Map(rows.map((r) => [r.providerTemplateId, r]));
  const out: TemplateView[] = provider.map((t) => {
    const row = byId.get(t.id);
    if (!row) return { ...t, submission: null };
    byId.delete(t.id);
    const newer = row.statusCheckedAt && (!fetchedAt || row.statusCheckedAt > fetchedAt);
    const status = newer ? { status: row.status as TemplateStatus, rejectionReason: row.rejectionReason } : {};
    return { ...t, ...status, submission: submissionOf(row) };
  });
  for (const row of byId.values()) out.push({ ...rowAsTemplate(row), submission: submissionOf(row) });
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}
