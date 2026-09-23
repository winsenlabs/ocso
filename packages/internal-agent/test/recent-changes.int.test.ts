import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditShipper, recordAudit, type ActorContext, type AuditStore } from '@ocso/application';
import type { Principal } from '@ocso/auth';
import { teams, uuidv7 } from '@ocso/db';
import { createTestAuditDatabase, createTestDatabase, type TestAuditDatabase, type TestDatabase } from '@ocso/db/testing';
import { recentChanges } from '../src/tools/system.js';

/** Ask OCSO's recent_changes reads the audit store with the caller's audit scope (ADR-032). */
let t: TestDatabase;
let a: TestAuditDatabase;
let store: AuditStore;
const teamA = uuidv7();
const teamB = uuidv7();
const leadA: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Ana', teamIds: [teamA], via: 'UI' };
const leadB: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Ben', teamIds: [teamB], via: 'UI' };
const tech: Principal = { userId: uuidv7(), role: 'TECH', displayName: 'Tia', teamIds: [], via: 'UI' };
const actor = (p: Principal): ActorContext => ({ principal: p, correlationId: 'recent-changes' });

beforeAll(async () => {
  t = await createTestDatabase();
  a = await createTestAuditDatabase();
  store = await a.openStore();
  await t.db.insert(teams).values([{ id: teamA, name: 'A' }, { id: teamB, name: 'B' }]);
  const write = (p: Principal, action: string) => t.db.transaction((tx) => recordAudit(tx, actor(p), { action, targetType: 'thing', targetId: uuidv7(), summary: `${p.displayName} ${action}` }));
  await write(leadA, 'a.shipped');
  await write(leadB, 'b.shipped');
  await new AuditShipper(t.db, store).ship();
  await write(leadA, 'a.pending');
});
afterAll(async () => {
  await store?.close();
  await t?.drop();
  await a?.drop();
});

const run = async (p: Principal) => {
  const answer = await recentChanges.run({ db: t.db, principal: p, actor: actor(p), now: new Date(), auditStore: store }, { limit: 50 });
  return (answer.data as Array<{ action: string }>).map((r) => r.action).sort();
};

describe('recent_changes (Ask OCSO)', () => {
  it("shows a lead only their teams' events, from the store and the unshipped outbox", async () => {
    expect(await run(leadA)).toEqual(['a.pending', 'a.shipped']);
    expect(await run(leadB)).toEqual(['b.shipped']);
  });

  it('shows the Tech admin everything', async () => {
    expect(await run(tech)).toEqual(['a.pending', 'a.shipped', 'b.shipped']);
  });
});
