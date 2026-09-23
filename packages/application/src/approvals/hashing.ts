import { contentHash } from '@ocso/prompt-compiler';
import type { DbOrTx } from '@ocso/db';
import type { ApprovalAction } from '@ocso/domain';
import type { ApprovalDescriptor } from './contract.js';

/**
 * Hashes that pin exactly what a checker approves (PM/research/11b). The
 * content hash covers the object's live projection before the change plus the
 * change itself; the dependency hash covers everything the change relies on
 * (`kind:id@updated_at`). Both are recomputed at decision and at deferred
 * activation, so an approval can only ever apply the bytes the checker saw.
 */

export type Snapshot = Record<string, unknown> | null;

/**
 * A projection as it is stored and compared: plain JSON (dates as ISO
 * strings, undefined dropped). Deliberately not `sanitizeForAudit`: its
 * key heuristics would blank legitimate configuration (maxOutputTokens) and
 * truncate prompt text the checker must read in full. Descriptors guarantee
 * projections never carry secrets (contract.ts); payload-redaction.test pins it.
 */
export function snapshotOf(value: Record<string, unknown> | null | undefined): Snapshot {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export interface ContentHashInput {
  objectKind: string;
  objectId: string;
  action: ApprovalAction;
  revision: number;
  payload: Record<string, unknown>;
  beforeSnapshot: Snapshot;
}

/**
 * `exclude`: top-level projection keys left out of the hash (the descriptor's
 * `hashExclude`) — state a stop action may change without voiding the
 * proposal, e.g. an agent's status: pausing Maya does not void "change Maya's
 * hours"; activation re-validates against the current state anyway.
 */
export function proposalContentHash(p: ContentHashInput, exclude: readonly string[] = []): string {
  const before = p.beforeSnapshot && exclude.length ? Object.fromEntries(Object.entries(p.beforeSnapshot).filter(([k]) => !exclude.includes(k))) : p.beforeSnapshot;
  return contentHash({ objectKind: p.objectKind, objectId: p.objectId, action: p.action, revision: p.revision, payload: snapshotOf(p.payload) ?? {}, before }, 'ap');
}

/** Order-insensitive hash of `kind:id@version` strings. */
export function dependencyHashOf(dependencies: readonly string[]): string {
  return contentHash([...new Set(dependencies)].sort(), 'ad');
}

/** `model_profile:<id>@2026-…` → `model_profile:<id>`. */
export function dependencyKeysOf(dependencies: readonly string[]): string[] {
  return [...new Set(dependencies.map((d) => d.split('@')[0] ?? d))].sort();
}

/** `kind:id@<updated_at ISO>`, or `@missing` when the row is gone. */
export function dependencyOf(kind: string, id: string, updatedAt: Date | null | undefined): string {
  return `${kind}:${id}@${updatedAt ? updatedAt.toISOString() : 'missing'}`;
}

/** What the content hash covers for this object right now: the descriptor's hashBasis, else the projection. */
export async function contentBasisOf(tx: DbOrTx, d: ApprovalDescriptor, objectId: string, projection: Snapshot): Promise<Snapshot> {
  if (!d.hashBasis || projection === null) return projection;
  return snapshotOf(await d.hashBasis(tx, objectId));
}
