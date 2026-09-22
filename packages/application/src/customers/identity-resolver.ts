import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { customerIdentities, customers, uuidv7, type DbOrTx } from '@ocso/db';

export interface IdentityClaim {
  kind: string;
  value: string;
}

export interface ResolveInput {
  primary: IdentityClaim;
  alternates: readonly IdentityClaim[];
  profileName?: string | undefined;
  now: Date;
}

export interface ResolvedCustomer {
  customerId: string;
  created: boolean;
  /** Alternate identities already linked to a different customer (left for a human to merge). */
  conflicts: IdentityClaim[];
}

/**
 * Deterministic identity resolution (docs/07 §3, docs/15 §4):
 * channel identity → CustomerIdentity → Customer. Concurrent first contact for
 * the same identity is serialized with a transaction-scoped advisory lock.
 * Customers are never merged automatically.
 */
export async function resolveCustomer(tx: DbOrTx, input: ResolveInput): Promise<ResolvedCustomer> {
  const claims = dedupeClaims([input.primary, ...input.alternates]);
  for (const claim of claims) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`identity:${claim.kind}:${claim.value}`}))`);
  }
  const existing = await tx
    .select({ kind: customerIdentities.kind, value: customerIdentities.value, customerId: customerIdentities.customerId })
    .from(customerIdentities)
    .where(or(...claims.map((c) => and(eq(customerIdentities.kind, c.kind), eq(customerIdentities.value, c.value)))));

  const primaryMatch = existing.find((e) => e.kind === input.primary.kind && e.value === input.primary.value);
  const customerId = primaryMatch?.customerId ?? existing[0]?.customerId ?? null;
  let created = false;
  let resolvedId: string;
  if (customerId) {
    resolvedId = customerId;
  } else {
    resolvedId = uuidv7();
    created = true;
    await tx.insert(customers).values({ id: resolvedId, displayName: input.profileName ?? null });
  }

  const conflicts = existing.filter((e) => e.customerId !== resolvedId).map(({ kind, value }) => ({ kind, value }));
  const known = new Set(existing.map((e) => `${e.kind}\u0000${e.value}`));
  const missing = claims.filter((c) => !known.has(`${c.kind}\u0000${c.value}`));
  if (missing.length) {
    await tx
      .insert(customerIdentities)
      .values(missing.map((c) => ({ id: uuidv7(), customerId: resolvedId, kind: c.kind, value: c.value, lastSeenAt: input.now })))
      .onConflictDoNothing();
  }
  const seen = existing.filter((e) => e.customerId === resolvedId);
  if (seen.length) {
    await tx
      .update(customerIdentities)
      .set({ lastSeenAt: input.now })
      .where(
        and(
          eq(customerIdentities.customerId, resolvedId),
          inArray(customerIdentities.kind, [...new Set(seen.map((s) => s.kind))]),
        ),
      );
  }
  if (!created && input.profileName) {
    await tx
      .update(customers)
      .set({ displayName: input.profileName })
      .where(and(eq(customers.id, resolvedId), sql`${customers.displayName} IS NULL`));
  }
  return { customerId: resolvedId, created, conflicts };
}

/**
 * Provider-announced identifier change (e.g. WhatsApp BSUID rotation): re-point
 * the existing identity row instead of creating a new customer.
 */
export async function relinkIdentity(tx: DbOrTx, kind: string, previousValue: string, currentValue: string): Promise<boolean> {
  const updated = await tx
    .update(customerIdentities)
    .set({ value: currentValue })
    .where(and(eq(customerIdentities.kind, kind), eq(customerIdentities.value, previousValue)))
    .returning({ id: customerIdentities.id });
  return updated.length > 0;
}

function dedupeClaims(claims: readonly IdentityClaim[]): IdentityClaim[] {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const key = `${c.kind}\u0000${c.value}`;
    if (!c.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
