import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { mcpConnections, tools, type DbOrTx } from '@ocso/db';
import { canonicalJson, sha256Hex } from '@ocso/mcp';
import type { ToolRow } from './records.js';

/** Tools of a USER-scope template, by server tool name. */
export type TemplateTools = ReadonlyMap<string, ToolRow>;

export interface ToolDefinitionFields {
  schemaHash: string;
  title?: string | null | undefined;
  description: string;
  outputSchema?: Record<string, unknown> | null | undefined;
  annotations?: Record<string, unknown> | null | undefined;
}

/**
 * Fingerprint of everything a reviewer approved: input schema (via
 * schemaHash), title, description, output schema and annotations. A change
 * to any of them — descriptions included, a prompt-injection vector — is
 * drift that needs re-approval.
 */
export function toolFingerprint(t: ToolDefinitionFields): string {
  return sha256Hex(
    canonicalJson({ s: t.schemaHash, t: t.title ?? null, d: t.description, o: t.outputSchema ?? null, a: t.annotations ?? {} }),
  );
}

export async function loadTemplateTools(db: DbOrTx, templateId: string): Promise<TemplateTools> {
  const rows = await db
    .select()
    .from(tools)
    .where(and(eq(tools.connectionId, templateId), isNull(tools.removedAt)));
  return new Map(rows.map((t) => [t.name, t]));
}

export type InheritedClassification = Pick<ToolRow, 'riskClass' | 'humanRoles' | 'requiredScopes' | 'enabled' | 'approved' | 'changedSinceApproval'>;

/**
 * What a personal copy of a tool inherits from the admin's template: the
 * classification, and approval only when the user's server returns exactly
 * the definition the admin approved. Unknown tools are never approved.
 */
export function inheritedClassification(templateTool: ToolRow | undefined, fingerprint: string, suggestedRisk: ToolRow['riskClass']): InheritedClassification {
  if (!templateTool) {
    return { riskClass: suggestedRisk, humanRoles: ['SERVICE', 'LEAD', 'HEAD'], requiredScopes: [], enabled: true, approved: false, changedSinceApproval: false };
  }
  return {
    riskClass: templateTool.riskClass,
    humanRoles: templateTool.humanRoles,
    requiredScopes: templateTool.requiredScopes,
    enabled: templateTool.enabled,
    approved: templateTool.approved && toolFingerprint(templateTool) === fingerprint,
    changedSinceApproval: false,
  };
}

/** Re-apply a template's (re)classification to every personal instance. Returns the personal connection ids touched. */
export async function propagateTemplateClassification(tx: DbOrTx, templateId: string, now: Date): Promise<string[]> {
  const template = await loadTemplateTools(tx, templateId);
  const personal = await tx
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.templateId, templateId), isNotNull(mcpConnections.ownerUserId)));
  if (!personal.length) return [];
  const ids = personal.map((p) => p.id);
  const copies = await tx
    .select()
    .from(tools)
    .where(and(inArray(tools.connectionId, ids), isNull(tools.removedAt)));
  const classification = (t: InheritedClassification) =>
    canonicalJson({ a: t.approved, r: t.riskClass, e: t.enabled, h: t.humanRoles, s: t.requiredScopes, c: t.changedSinceApproval });
  for (const copy of copies) {
    const next = inheritedClassification(template.get(copy.name), toolFingerprint(copy), copy.suggestedRisk);
    if (classification(next) !== classification(copy)) await tx.update(tools).set({ ...next, updatedAt: now }).where(eq(tools.id, copy.id));
  }
  return ids;
}
