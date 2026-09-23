import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { users, uuidv7, type Db } from '@ocso/db';
import type { ApprovalAction } from '@ocso/domain';
import { ApprovalDecisionService, ApprovalService, createApprovalRegistry, type ActorContext, type PlatformApprovalDeps, type ProposalDetail } from '../../src/index.js';

/**
 * Approving platform objects in tests the way a deployment does (PM/research/11 §4): the maker proposes, a
 * second person — a Head, who holds approvals.check.platform and approvals.check.channels — approves. Makers
 * and the checker are real users (proposals reference them), created on first use.
 */
export interface PlatformApprover {
  checker: Principal;
  approvals: ApprovalService;
  decisions: ApprovalDecisionService;
  /** Submit as `maker` naming the checker; returns the open proposal. */
  submit(maker: ActorContext, kind: string, objectId: string, action: ApprovalAction, payload?: Record<string, unknown>): Promise<ProposalDetail>;
  /** Submit and approve; returns the decided proposal. */
  approve(maker: ActorContext, kind: string, objectId: string, action: ApprovalAction, payload?: Record<string, unknown>): Promise<ProposalDetail>;
  /** Approve an open proposal as the checker. */
  decide(proposal: ProposalDetail): Promise<ProposalDetail>;
  /** Finish a deferred activation (the worker's job). */
  finish(proposalId: string): Promise<string>;
}

export async function ensureUser(db: Db, p: Principal): Promise<void> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
  if (!row) await db.insert(users).values({ id: p.userId, email: `${p.userId.slice(-12)}@platform.test`, name: p.displayName, role: p.role });
}

export async function platformApprover(db: Db, deps: PlatformApprovalDeps = {}): Promise<PlatformApprover> {
  const registry = createApprovalRegistry({ platform: deps });
  const approvals = new ApprovalService(db, registry);
  const decisions = new ApprovalDecisionService(db, registry);
  const checker: Principal = { userId: uuidv7(), role: 'HEAD', displayName: 'Priya Checker', teamIds: [], via: 'UI' };
  await ensureUser(db, checker);
  const checkerActor: ActorContext = { principal: checker, correlationId: 'platform-checker' };
  const submit: PlatformApprover['submit'] = async (maker, kind, objectId, action, payload) => {
    await ensureUser(db, maker.principal!);
    return approvals.submit(maker, { objectKind: kind, objectId, action, checkerId: checker.userId, reason: 'Platform test change', ...(payload ? { payload } : {}) });
  };
  const decide: PlatformApprover['decide'] = (proposal) => decisions.decide(checkerActor, proposal.id, { decision: 'APPROVE', reason: 'Reviewed', contentHash: proposal.contentHash });
  return {
    checker,
    approvals,
    decisions,
    submit,
    decide,
    approve: async (maker, kind, objectId, action, payload) => decide(await submit(maker, kind, objectId, action, payload)),
    finish: (proposalId) => decisions.finishActivation(checkerActor, proposalId),
  };
}
