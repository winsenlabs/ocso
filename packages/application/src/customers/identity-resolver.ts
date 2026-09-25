import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { customerIdentities, customers, uuidv7, type DbOrTx } from '@ocso/db';

export interface IdentityClaim {
  kind: string;
  value: string;
}

export interface ResolveCustomerInput {
  primary: IdentityClaim;
  alternates: readonly IdentityClaim[];
  profileName?: string | undefined;
  /** The channel verified the primary identity (e.g. a site-verified user): mark it `verified`. */
  primaryVerified?: boolean | undefined;
  now: Date;
}

export interface ResolvedCustomer {
  customerId: string;
  created: boolean;
  /** Alternate identities already linked to a different customer (left for a human to merge). */
  conflicts: IdentityClaim[];
}

/**
 * Deterministic identity resolution (docs/archive/specs/07 §3, docs/archive/specs/15 §4):
 * channel identity → CustomerIdentity → Customer. Concurrent first contact for
 * the same identity is serialized with a transaction-scoped advisory lock.
 * Customers are never merged automatically.
 */
export async function resolveCustomer(tx: DbOrTx, input: ResolveCustomerInput): Promise<ResolvedCustomer> {
  const claims = dedupeClaims([input.primary, ...input.alternates]);
  for (const claim of claims) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`identity:${claim.kind}:${claim.value}`}))`);
  }
  const existing = await tx
    .select({ kind: customerIdentities.kind, value: customerIdentities.value, customerId: customerIdentities.customerId })
    .from(customerIdentities)
    .where(or(...claims.map((c) => and(eq(customerIdentities.kind, c.kind), eq(customerIdentities.value, c.value)))));

  const customerId = await pickCustomer(tx, input, existing);
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
  if (input.primaryVerified) {
    await tx
      .update(customerIdentities)
      .set({ verified: true })
      .where(and(eq(customerIdentities.customerId, resolvedId), eq(customerIdentities.kind, input.primary.kind), eq(customerIdentities.value, input.primary.value)));
  }
  if (!created && input.profileName) {
    await tx
      .update(customers)
      .set({ displayName: input.profileName })
      .where(and(eq(customers.id, resolvedId), sql`${customers.displayName} IS NULL`));
  }
  return { customerId: resolvedId, created, conflicts };
}

export interface CustomerLookup {
  primary: IdentityClaim;
  alternates: readonly IdentityClaim[];
  primaryVerified?: boolean | undefined;
}

/**
 * The customer `resolveCustomer` would pick for these identities, without writing anything (the web chat
 * history and stream use it to find the conversation the caller's next message joins).
 */
export async function lookupCustomer(db: DbOrTx, input: CustomerLookup): Promise<string | null> {
  const claims = dedupeClaims([input.primary, ...input.alternates]);
  if (!claims.length) return null;
  const existing = await db
    .select({ kind: customerIdentities.kind, value: customerIdentities.value, customerId: customerIdentities.customerId })
    .from(customerIdentities)
    .where(or(...claims.map((c) => and(eq(customerIdentities.kind, c.kind), eq(customerIdentities.value, c.value)))));
  return pickCustomer(db, input, existing);
}

/**
 * The primary identity's customer; else the first alternate's. A verified primary never joins a customer that
 * already holds a different identity of its kind (another verified user): an alternate such as a shared
 * browser's visitor id must not merge two signed-in people. Then a new customer is created instead.
 */
async function pickCustomer(db: DbOrTx, input: CustomerLookup, existing: ReadonlyArray<{ kind: string; value: string; customerId: string }>): Promise<string | null> {
  const primaryMatch = existing.find((e) => e.kind === input.primary.kind && e.value === input.primary.value);
  if (primaryMatch) return primaryMatch.customerId;
  const ordered = dedupeClaims(input.alternates)
    .map((a) => existing.find((e) => e.kind === a.kind && e.value === a.value)?.customerId)
    .filter((id): id is string => Boolean(id));
  if (!input.primaryVerified || !ordered.length) return ordered[0] ?? null;
  const taken = await db
    .selectDistinct({ customerId: customerIdentities.customerId })
    .from(customerIdentities)
    .where(and(inArray(customerIdentities.customerId, [...new Set(ordered)]), eq(customerIdentities.kind, input.primary.kind), ne(customerIdentities.value, input.primary.value)));
  const blocked = new Set(taken.map((t) => t.customerId));
  return ordered.find((id) => !blocked.has(id)) ?? null;
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
