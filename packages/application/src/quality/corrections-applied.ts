import { and, eq, inArray } from 'drizzle-orm';
import { notFound } from '@ocso/domain';
import { promptCorrections, promptVersions, type DbOrTx } from '@ocso/db';

/**
 * Mark corrections APPLIED once a prompt version that includes them exists.
 * Call after PromptService.createVersionFromDraft; defaults to the version's
 * own correctionIds. Only OPEN/STAGED corrections of the same agent change.
 */
export async function markCorrectionsApplied(db: DbOrTx, versionId: string, correctionIds?: readonly string[]): Promise<number> {
  const [version] = await db.select({ agentId: promptVersions.agentId, correctionIds: promptVersions.correctionIds }).from(promptVersions).where(eq(promptVersions.id, versionId));
  if (!version) throw notFound('prompt_version', versionId);
  const ids = [...(correctionIds ?? version.correctionIds ?? [])];
  if (!ids.length) return 0;
  const updated = await db
    .update(promptCorrections)
    .set({ status: 'APPLIED', resultingVersionId: versionId, updatedAt: new Date() })
    .where(and(inArray(promptCorrections.id, ids), eq(promptCorrections.agentId, version.agentId), inArray(promptCorrections.status, ['OPEN', 'STAGED'])))
    .returning({ id: promptCorrections.id });
  return updated.length;
}
