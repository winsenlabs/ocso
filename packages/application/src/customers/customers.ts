import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { forbidden, notFound } from '@ocso/domain';
import { conversations, customerIdentities, customers, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import type { ActorContext } from '../shared/context.js';
import { conversationScope, type VisibilityPolicy } from '../conversations/access.js';
import { maskIdentity } from '../conversations/masking.js';

export const CustomerPatch = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  language: z.string().max(20).nullable().optional(),
  externalRef: z.string().max(200).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  accountOwnerUserId: z.uuid().nullable().optional(),
});
export type CustomerPatch = z.infer<typeof CustomerPatch>;

/**
 * Customers (docs/archive/specs/03 Customer). Everyone sees exactly the customers they have
 * a visible conversation with (conversationScope: a Lead's teams' agents
 * and queues, an exec's queues and assignments — ADR-026); others are not
 * found. Attribute changes are "material customer context" and invalidate
 * turn caches (docs/archive/specs/05 §5).
 */
export class CustomerService {
  constructor(private readonly db: Db) {}

  private scope(principal: Principal, policy: VisibilityPolicy): SQL | undefined {
    const convScope = conversationScope(principal, policy);
    return sql`EXISTS (SELECT 1 FROM ${conversations} WHERE ${conversations.customerId} = ${customers.id} ${convScope ? sql`AND ${convScope}` : sql``})`;
  }

  async search(principal: Principal, policy: VisibilityPolicy, q: { search?: string | undefined; limit: number }) {
    assertCan(principal, Permission.CUSTOMERS_READ);
    const like = q.search ? `%${q.search.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
    const rows = await this.db
      .select()
      .from(customers)
      .where(
        and(
          this.scope(principal, policy),
          like
            ? or(ilike(customers.displayName, like), ilike(customers.externalRef, like), sql`EXISTS (SELECT 1 FROM ${customerIdentities} WHERE ${customerIdentities.customerId} = ${customers.id} AND ${customerIdentities.value} ILIKE ${like})`)
            : undefined,
        ),
      )
      .orderBy(desc(customers.updatedAt))
      .limit(q.limit);
    const identities = rows.length ? await this.db.select().from(customerIdentities).where(inArray(customerIdentities.customerId, rows.map((r) => r.id))) : [];
    return rows.map((c) => ({
      ...c,
      identities: identities.filter((i) => i.customerId === c.id).map((i) => ({ kind: i.kind, display: maskIdentity(`${i.kind}:${i.value}`) })),
    }));
  }

  async get(principal: Principal, policy: VisibilityPolicy, id: string) {
    assertCan(principal, Permission.CUSTOMERS_READ);
    const [row] = await this.db.select().from(customers).where(and(eq(customers.id, id), this.scope(principal, policy)));
    if (!row) throw forbidden('customer', 'not permitted or not found');
    const identities = await this.db.select().from(customerIdentities).where(eq(customerIdentities.customerId, id));
    // Only conversations this principal may open: previews are message content.
    const convScope = conversationScope(principal, policy);
    const convs = await this.db
      .select({ id: conversations.id, controlState: conversations.controlState, openedAt: conversations.openedAt, lastPreview: conversations.lastPreview, agentId: conversations.agentId })
      .from(conversations)
      .where(convScope ? and(eq(conversations.customerId, id), convScope) : eq(conversations.customerId, id))
      .orderBy(desc(conversations.openedAt))
      .limit(50);
    return { ...row, identities: identities.map((i) => ({ kind: i.kind, display: maskIdentity(`${i.kind}:${i.value}`), verified: i.verified })), conversations: convs };
  }

  /** Only customers the actor can see (same scope as get); the policy decides exec visibility. */
  async update(actor: ActorContext, id: string, patch: CustomerPatch, policy: VisibilityPolicy): Promise<void> {
    assertCan(actor.principal!, Permission.CUSTOMERS_MANAGE);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(customers).where(and(eq(customers.id, id), this.scope(actor.principal!, policy))).for('update');
      if (!before) throw notFound('customer', id);
      await tx
        .update(customers)
        .set({ ...patch, contextVersion: sql`${customers.contextVersion} + 1`, updatedAt: new Date() })
        .where(eq(customers.id, id));
      await recordAudit(tx, actor, { action: 'customer.update', targetType: 'customer', targetId: id, summary: 'Updated customer context', before, after: patch });
      await bumpGeneration(tx, actor.correlationId, `customer:${id}`, 'customer_context_changed');
    });
  }
}
