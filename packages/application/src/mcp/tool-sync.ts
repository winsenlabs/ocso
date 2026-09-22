import { eq, inArray } from 'drizzle-orm';
import { tools, uuidv7, type DbOrTx } from '@ocso/db';
import type { DiscoveredTool } from '@ocso/mcp';
import type { ConnectionRow, ToolRow } from './records.js';
import { inheritedClassification, toolFingerprint, type TemplateTools } from './template-mirror.js';

export interface ToolSyncSummary {
  total: number;
  added: number;
  /** Definition drift on existing tools (schema, description, annotations…). */
  changed: number;
  /** Tools that disappeared from the server (`removedAt` set). */
  removed: number;
  /** Previously removed tools that came back. */
  restored: number;
  /** Approved tools that drifted and were un-approved until an admin re-approves them. */
  needsReapproval: string[];
  /** Whether any tool visible to agents changed (drives catalogue cache invalidation). */
  catalogChanged: boolean;
}

const RISK_ORDER: Readonly<Record<ToolRow['riskClass'], number>> = { READ: 0, WRITE: 1, SENSITIVE: 2 };
const stricter = (a: ToolRow['riskClass'], b: ToolRow['riskClass']) => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

/** A unique placeholder model name for retired tools and for rows whose name is moving (unique index). */
const parkedName = (id: string) => `x_${id.replace(/-/g, '')}`;

function definitionFields(d: DiscoveredTool) {
  return {
    name: d.name,
    modelName: d.modelName,
    title: d.title ?? null,
    description: d.description,
    inputSchema: d.inputSchema,
    outputSchema: d.outputSchema ?? null,
    annotations: (d.annotations ?? {}) as Record<string, unknown>,
    schemaHash: d.schemaHash,
    suggestedRisk: d.suggestedRisk,
  };
}

const fingerprintOf = (d: DiscoveredTool) => toolFingerprint(definitionFields(d));

/**
 * Reconcile a connection's `tools` rows with a fresh discovery: insert new
 * tools unapproved, update drifted ones (an approved tool whose definition
 * changed is un-approved and flagged `changedSinceApproval`; its risk class
 * never silently gets less strict), mark vanished tools `removedAt`, and
 * restore tools that came back. Personal connections inherit their
 * template's classification instead of admin review.
 */
export async function syncDiscoveredTools(
  tx: DbOrTx,
  conn: ConnectionRow,
  discovered: readonly DiscoveredTool[],
  now: Date,
  template: TemplateTools | null,
): Promise<ToolSyncSummary> {
  const existing = await tx.select().from(tools).where(eq(tools.connectionId, conn.id));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const incoming = new Map(discovered.map((d) => [d.name, d]));
  const retired = existing.filter((t) => !t.removedAt && !incoming.has(t.name));
  const moving = existing.filter((t) => incoming.has(t.name) && incoming.get(t.name)!.modelName !== t.modelName);

  for (const t of [...retired, ...moving]) {
    if (t.modelName !== parkedName(t.id)) await tx.update(tools).set({ modelName: parkedName(t.id) }).where(eq(tools.id, t.id));
  }
  if (retired.length) {
    await tx
      .update(tools)
      .set({ removedAt: now, updatedAt: now })
      .where(
        inArray(
          tools.id,
          retired.map((t) => t.id),
        ),
      );
  }

  const summary: ToolSyncSummary = {
    total: discovered.length,
    added: 0,
    changed: 0,
    removed: retired.length,
    restored: 0,
    needsReapproval: [],
    catalogChanged: retired.some((t) => t.approved),
  };
  for (const d of discovered) {
    const prev = byName.get(d.name);
    if (!prev) {
      const inherit = template ? inheritedClassification(template.get(d.name), fingerprintOf(d), d.suggestedRisk) : null;
      await tx.insert(tools).values({
        id: uuidv7(),
        connectionId: conn.id,
        ...definitionFields(d),
        riskClass: d.suggestedRisk,
        approved: false,
        discoveredAt: now,
        updatedAt: now,
        ...(inherit ?? {}),
      });
      summary.added++;
      continue;
    }
    await reconcile(tx, prev, d, now, template, summary);
  }
  return summary;
}

async function reconcile(tx: DbOrTx, prev: ToolRow, d: DiscoveredTool, now: Date, template: TemplateTools | null, summary: ToolSyncSummary): Promise<void> {
  const fingerprint = fingerprintOf(d);
  const changed = toolFingerprint(prev) !== fingerprint;
  const restored = prev.removedAt !== null;
  const renamed = prev.modelName !== d.modelName;
  if (!changed && !restored && !renamed) return;

  const inherit = template ? inheritedClassification(template.get(d.name), fingerprint, d.suggestedRisk) : null;
  const reapproval = changed && prev.approved && !inherit;
  await tx
    .update(tools)
    .set({
      ...definitionFields(d),
      removedAt: null,
      updatedAt: now,
      ...(changed && !inherit ? { riskClass: stricter(prev.riskClass, d.suggestedRisk) } : {}),
      ...(reapproval ? { approved: false, changedSinceApproval: true } : {}),
      ...(inherit ?? {}),
    })
    .where(eq(tools.id, prev.id));

  if (changed) summary.changed++;
  if (restored) summary.restored++;
  if (reapproval) summary.needsReapproval.push(prev.id);
  if (prev.approved) summary.catalogChanged = true;
}
