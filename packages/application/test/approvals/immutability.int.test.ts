import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/**
 * approval_decisions is append-only (trigger, like audit_events); a proposal is frozen once decided and never
 * deleted; prompt versions stay immutable.
 */
let f: ApprovalFixture;
let decided: string;
let open: string;
beforeAll(async () => {
  f = await createApprovalFixture();
  decided = (await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { action: 'ACTIVATE' })).id)).id;
  open = (await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'open one' } })).id;
  void act;
});
afterAll(async () => {
  await f?.t.drop();
});

describe('append-only decisions', () => {
  it.each([
    ['UPDATE', sql`UPDATE approval_decisions SET reason = 'rewritten'`],
    ['DELETE', sql`DELETE FROM approval_decisions`],
    ['TRUNCATE', sql`TRUNCATE approval_decisions`],
  ])('rejects %s', async (_op, statement) => {
    await expect(f.t.db.execute(statement)).rejects.toMatchObject({ cause: { message: 'approval_decisions is append-only' } });
  });

  it('keeps prompt versions immutable outside an approved agent delete', async () => {
    await expect(f.t.db.execute(sql`DELETE FROM prompt_versions`)).rejects.toMatchObject({ cause: { message: 'prompt_versions are immutable' } });
  });
});

describe('decided proposals are frozen', () => {
  const guard = (message: string) => ({ cause: { message: expect.stringContaining(message) } });

  it.each([
    ['flip a decision', sql`UPDATE approval_proposals SET status = 'REJECTED' WHERE status = 'APPROVED'`, 'cannot change status'],
    ['rewrite the checker', sql`UPDATE approval_proposals SET checker_id = maker_id WHERE status = 'APPROVED'`, 'frozen'],
    ['rewrite the payload', sql`UPDATE approval_proposals SET payload = '{"x":1}' WHERE status = 'APPROVED'`, 'frozen'],
    ['re-stamp activation', sql`UPDATE approval_proposals SET activated_at = now() + interval '1 day' WHERE status = 'APPROVED'`, 'stamped once'],
    ['delete one', sql`DELETE FROM approval_proposals`, 'never deleted'],
    ['truncate', sql`TRUNCATE approval_proposals CASCADE`, 'never deleted'],
  ])('refuses to %s', async (_what, statement, message) => {
    await expect(f.t.db.execute(statement)).rejects.toMatchObject(guard(message));
  });

  it('never changes who made an open proposal, and never inserts one already decided', async () => {
    await expect(f.t.db.execute(sql`UPDATE approval_proposals SET maker_id = checker_id WHERE id = ${open}`)).rejects.toMatchObject(guard('never change'));
    await expect(
      f.t.db.execute(sql`INSERT INTO approval_proposals (id, object_kind, object_id, action, status, content_hash, dependency_hash, title, reason)
        VALUES (gen_random_uuid(), 'agent', ${f.maya}, 'DELETE', 'APPROVED', 'ap_x', 'ad_x', 't', 'forged')`),
    ).rejects.toMatchObject(guard('created SUBMITTED'));
  });

  it('refuses a decision recorded by its own maker (outside bootstrap, withdraw and void)', async () => {
    await expect(f.t.db.execute(sql`UPDATE approval_proposals SET status = 'APPROVED', decided_by = maker_id, decided_at = now() WHERE id = ${open}`)).rejects.toMatchObject({
      cause: { constraint: 'approval_proposals_decider_ck' },
    });
    void decided;
  });
});
