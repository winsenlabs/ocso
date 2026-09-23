import { and, eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { modelPricing, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalDescriptor, ProposalRow } from '../approvals/contract.js';
import { isApproved } from '../approvals/guard.js';
import { definedOnly, platformVisible } from '../settings/platform-approvals.js';
import { PricingPatch } from './inputs.js';

/**
 * Manual price rows under maker–checker (PM/research/11 §4, approvals.check.platform). A price a person enters
 * starts as a DRAFT row that prices nothing (`selectPrice` skips it); ACTIVATE makes it count. A live price
 * row — approved, grandfathered, or a catalog row the system maintains — changes only through an UPDATE
 * proposal (a person's edit of a catalog price makes it manual, as before), and DELETE is always a proposal.
 * The system's own catalog refreshes stay direct and audited: they are not a person's change.
 */

type PricingRow = typeof modelPricing.$inferSelect;

async function load(tx: DbOrTx, id: string): Promise<PricingRow | null> {
  const [row] = await tx.select().from(modelPricing).where(eq(modelPricing.id, id));
  return row ?? null;
}

const micros = (v: number | null) => (v === null ? null : `${(v / 1_000_000).toFixed(4)} per 1M tokens`);

function projectRow(row: PricingRow, patch?: PricingPatch): Record<string, unknown> {
  const { effectiveFrom: _e, ...fields } = patch ?? {};
  const next = { ...row, ...(definedOnly(fields) as Partial<PricingRow>) };
  return {
    name: `${row.providerKind} ${next.modelPattern}`,
    providerKind: row.providerKind,
    modelPattern: next.modelPattern,
    currency: next.currency,
    input: micros(next.inputPerMTokMicros),
    cachedInput: micros(next.cachedInputPerMTokMicros),
    cacheWrite: micros(next.cacheWritePerMTokMicros),
    output: micros(next.outputPerMTokMicros),
    effectiveFrom: patch?.effectiveFrom ?? row.effectiveFrom.toISOString(),
    origin: patch ? 'manual' : row.origin,
    status: row.status,
  };
}

/** A person's change to this row must be a proposal: it is live (approved, or ACTIVE — catalog rows are live by design). */
export async function pricingGoverned(tx: DbOrTx, id: string): Promise<boolean> {
  const row = await load(tx, id);
  return Boolean(row && (row.status === 'ACTIVE' || (await isApproved(tx, 'model_pricing', id))));
}

export const pricingApproval: ApprovalDescriptor = {
  kind: 'model_pricing',
  label: 'Model price',
  actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
  makePermission: () => Permission.PRICING_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
  payload: PricingPatch,

  async project(tx, id) {
    const row = await load(tx, id);
    return row ? projectRow(row) : null;
  },
  async projectAfter(tx, p) {
    const row = await load(tx, p.objectId);
    if (!row || p.action === 'DELETE') return null;
    if (p.action === 'ACTIVATE') return { ...projectRow(row), status: 'ACTIVE' };
    return projectRow(row, p.payload as PricingPatch);
  },
  teamIds: async () => [],
  dependencies: async () => [],
  assertVisible: platformVisible(Permission.PRICING_MANAGE),
  async requiresApproval(tx, id, action) {
    return action === 'ACTIVATE' || action === 'DELETE' || pricingGoverned(tx, id);
  },
  async validate(tx, p) {
    const row = await load(tx, p.objectId);
    if (!row) return [{ code: 'object_missing', message: 'The price row no longer exists.' }];
    if (p.action === 'ACTIVATE' && row.status === 'ACTIVE') return [{ code: 'already_active', message: 'The price is already in use.' }];
    return [];
  },
  async activate(tx, actor, p) {
    const row = (await load(tx, p.objectId))!;
    const label = `${row.providerKind} ${row.modelPattern}`;
    if (p.action === 'DELETE') {
      await tx.delete(modelPricing).where(eq(modelPricing.id, row.id));
      await recordAudit(tx, actor, { action: 'model_pricing.delete', targetType: 'model_pricing', targetId: row.id, summary: `Removed pricing for ${label}`, before: row });
    } else if (p.action === 'ACTIVATE') {
      await tx.update(modelPricing).set({ status: 'ACTIVE', updatedAt: new Date() }).where(and(eq(modelPricing.id, row.id), eq(modelPricing.status, 'DRAFT')));
      await recordAudit(tx, actor, { action: 'model_pricing.activate', targetType: 'model_pricing', targetId: row.id, summary: `Pricing for ${label} now applies`, before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } });
    } else {
      const { effectiveFrom, ...fields } = p.payload as PricingPatch;
      await tx
        .update(modelPricing)
        .set({ ...definedOnly(fields), origin: 'manual', updatedAt: new Date(), ...(effectiveFrom ? { effectiveFrom: new Date(effectiveFrom) } : {}) })
        .where(eq(modelPricing.id, row.id));
      await recordAudit(tx, actor, {
        action: 'model_pricing.update',
        targetType: 'model_pricing',
        targetId: row.id,
        summary: `Updated pricing for ${label}${row.origin === 'catalog' ? ' (catalog price overridden)' : ''}`,
        before: row,
        after: p.payload,
      });
    }
    await emitEvent(tx, actor, 'config.changed', { area: 'model_pricing', entityId: row.id });
    return { kind: 'DONE' };
  },
  async liveObjects(tx) {
    // Catalog rows are the system's, refreshed directly; a person's live price is an ACTIVE manual row.
    return (await tx.select({ id: modelPricing.id }).from(modelPricing).where(and(eq(modelPricing.status, 'ACTIVE'), eq(modelPricing.origin, 'manual')))).map((r) => r.id);
  },
  title(p: ProposalRow, before) {
    const name = String(before?.['name'] ?? 'price');
    if (p.action === 'ACTIVATE') return `Apply price for ${name}`;
    if (p.action === 'DELETE') return `Remove price for ${name}`;
    return `Change price for ${name}`;
  },
};
