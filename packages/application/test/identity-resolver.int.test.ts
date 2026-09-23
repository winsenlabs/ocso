import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customerIdentities, customers, uuidv7 } from '@ocso/db';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { lookupCustomer, resolveCustomer } from '../src/index.js';

/** A verified identity never joins a customer through an alternate that already belongs to another verified user. */

let t: TestDatabase;
const now = new Date('2026-09-23T10:00:00Z');
const REF = 'webchat_customer_ref';
const VISITOR = 'webchat_visitor';

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

const identitiesOf = async (customerId: string) =>
  (await t.db.select({ kind: customerIdentities.kind, value: customerIdentities.value }).from(customerIdentities).where(eq(customerIdentities.customerId, customerId))).map((i) => `${i.kind}=${i.value}`).sort();

describe('identity resolution with verified users', () => {
  it('a guest who signs in keeps their customer (the visitor is an alternate)', async () => {
    const guest = await t.db.transaction((tx) => resolveCustomer(tx, { primary: { kind: VISITOR, value: 'v_guest_0001' }, alternates: [], now }));
    const input = { primary: { kind: REF, value: 'ch:alice' }, alternates: [{ kind: VISITOR, value: 'v_guest_0001' }], primaryVerified: true };
    expect(await lookupCustomer(t.db, input)).toBe(guest.customerId);
    const signedIn = await t.db.transaction((tx) => resolveCustomer(tx, { ...input, now }));
    expect(signedIn).toMatchObject({ customerId: guest.customerId, created: false });
    expect(await identitiesOf(guest.customerId)).toEqual([`${REF}=ch:alice`, `${VISITOR}=v_guest_0001`]);
  });

  it('another verified user carrying that visitor as an alternate gets a customer of their own', async () => {
    const alice = (await lookupCustomer(t.db, { primary: { kind: REF, value: 'ch:alice' }, alternates: [] }))!;
    const input = { primary: { kind: REF, value: 'ch:bob' }, alternates: [{ kind: VISITOR, value: 'v_guest_0001' }], primaryVerified: true };
    expect(await lookupCustomer(t.db, input)).toBeNull();
    const bob = await t.db.transaction((tx) => resolveCustomer(tx, { ...input, now }));
    expect(bob.created).toBe(true);
    expect(bob.customerId).not.toBe(alice);
    expect(bob.conflicts).toEqual([{ kind: VISITOR, value: 'v_guest_0001' }]);
    expect(await identitiesOf(alice)).toEqual([`${REF}=ch:alice`, `${VISITOR}=v_guest_0001`]);
    expect(await identitiesOf(bob.customerId)).toEqual([`${REF}=ch:bob`]);
    expect(await lookupCustomer(t.db, input)).toBe(bob.customerId);
  });

  it('skips a taken alternate for a free one, and unverified callers keep the old precedence', async () => {
    const free = uuidv7();
    await t.db.insert(customers).values({ id: free });
    await t.db.insert(customerIdentities).values({ id: uuidv7(), customerId: free, kind: VISITOR, value: 'v_free_00001', lastSeenAt: now });
    const alice = (await lookupCustomer(t.db, { primary: { kind: REF, value: 'ch:alice' }, alternates: [] }))!;
    const alternates = [{ kind: VISITOR, value: 'v_guest_0001' }, { kind: VISITOR, value: 'v_free_00001' }];
    expect(await lookupCustomer(t.db, { primary: { kind: REF, value: 'ch:carol' }, alternates, primaryVerified: true })).toBe(free);
    expect(await lookupCustomer(t.db, { primary: { kind: VISITOR, value: 'v_new_000001' }, alternates })).toBe(alice);
  });
});
