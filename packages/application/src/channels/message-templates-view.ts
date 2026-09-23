import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { TemplateDraftSchema, draftAsTemplate, type MessageTemplate, type TemplateStatus } from '@ocso/domain';
import { users, messageTemplates, type DbOrTx } from '@ocso/db';

export type TemplateRow = typeof messageTemplates.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A proposal waiting on this template (submit or delete), or an approved one the worker is still finishing. */
export interface TemplateApprovalRef {
  proposalId: string;
  action: 'CREATE' | 'DELETE';
  checkerName: string | null;
  /** Approved; the provider call has not finished yet. */
  activating: boolean;
}

/** OCSO's own record of a template drafted or submitted from here. */
export interface TemplateSubmission {
  recordId: string;
  submittedBy: { id: string; name: string } | null;
  submittedAt: string;
  statusChangedAt: string | null;
  /** Saved in OCSO only: the provider has never seen it (it is submitted through an approval). */
  draft: boolean;
  /** Made in the provider's console; recorded because a deletion was proposed from OCSO. */
  providerMade: boolean;
  /** An open (or activating) approval on the template; filled by the list. */
  approval: TemplateApprovalRef | null;
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
  /** Why the provider list is unavailable (credentials, missing account id, provider down). */
  problem: { code: string; message: string } | null;
}

/**
 * OCSO's rows of a channel (not deleted), with the submitter's name: drafts and submitted templates. `ids` are
 * provider template ids, or OCSO record ids for drafts the provider has never seen.
 */
export async function submittedRows(db: DbOrTx, channelId: string, ids?: readonly string[]): Promise<Array<TemplateRow & { submitterName: string | null }>> {
  const uuids = ids?.filter((id) => UUID.test(id)) ?? [];
  const rows = await db
    .select({ t: messageTemplates, submitterName: users.name })
    .from(messageTemplates)
    .leftJoin(users, eq(users.id, messageTemplates.submittedBy))
    .where(
      and(
        eq(messageTemplates.channelId, channelId),
        isNull(messageTemplates.deletedAt),
        ids ? or(inArray(messageTemplates.providerTemplateId, ids.length ? [...ids] : ['']), uuids.length ? and(isNull(messageTemplates.providerTemplateId), inArray(messageTemplates.id, uuids)) : undefined) : undefined,
      ),
    );
  return rows.map((r) => ({ ...r.t, submitterName: r.submitterName }));
}

function submissionOf(row: TemplateRow & { submitterName: string | null }, approvals: ReadonlyMap<string, TemplateApprovalRef>): TemplateSubmission {
  return {
    recordId: row.id,
    submittedBy: row.submittedBy ? { id: row.submittedBy, name: row.submitterName ?? 'former user' } : null,
    submittedAt: row.submittedAt.toISOString(),
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
    draft: row.providerTemplateId === null,
    providerMade: row.origin === 'PROVIDER',
    approval: approvals.get(row.id) ?? null,
  };
}

/** A submitted row as a template, for when the provider has not listed it (yet). */
export function rowAsTemplate(row: TemplateRow): MessageTemplate {
  const draft = TemplateDraftSchema.parse(row.definition);
  // The provider's variable-key scheme is recorded with the submitted definition.
  const scope = row.definition['placeholderScope'] === 'component' ? 'component' : 'template';
  // A draft the provider has never seen is addressed by OCSO's record id.
  return draftAsTemplate(draft, { id: row.providerTemplateId ?? row.id, status: row.status as TemplateStatus, rejectionReason: row.rejectionReason, scope });
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
  approvals: ReadonlyMap<string, TemplateApprovalRef> = new Map(),
): TemplateView[] {
  const byId = new Map(rows.flatMap((r) => (r.providerTemplateId ? [[r.providerTemplateId, r] as const] : [])));
  const out: TemplateView[] = provider.map((t) => {
    const row = byId.get(t.id);
    if (!row) return { ...t, submission: null };
    byId.delete(t.id);
    const newer = row.statusCheckedAt && (!fetchedAt || row.statusCheckedAt > fetchedAt);
    const status = newer ? { status: row.status as TemplateStatus, rejectionReason: row.rejectionReason } : {};
    return { ...t, ...status, submission: submissionOf(row, approvals) };
  });
  const drafts = rows.filter((r) => r.providerTemplateId === null);
  for (const row of [...byId.values(), ...drafts]) out.push({ ...rowAsTemplate(row), submission: submissionOf(row, approvals) });
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
}
