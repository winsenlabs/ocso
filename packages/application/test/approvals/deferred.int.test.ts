import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { approvalDecisions, approvalProposals, virtualAgents } from '@ocso/db';
import { DomainError } from '@ocso/domain';
import {
  ApprovalDecisionService,
  ApprovalRegistry,
  ApprovalService,
  agentApproval,
  systemActor,
  type ApprovalDescriptor,
} from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/**
 * Deferred activation (PM/research/11b): a kind whose activation leaves the
 * transaction (a provider call) is APPROVED with activated_at NULL, then the
 * worker re-validates and re-checks both hashes before touching the provider.
 * A test kind stands in for message templates (wave 2): it renames an agent
 * "at the provider".
 */
let f: ApprovalFixture;
const providerCalls: string[] = [];
let failNext: 'retry' | 'terminal' | null = null;
let slow: Promise<void> | null = null;

const renameAtProvider: ApprovalDescriptor = {
  ...agentApproval,
  kind: 'provider_rename',
  label: 'Provider rename',
  actions: ['UPDATE'],
  hashExclude: [],
  async activate() {
    return { kind: 'DEFERRED' };
  },
  async activateDeferred(db, _actor, p) {
    if (failNext === 'retry') {
      failNext = null;
      throw new Error('provider timed out');
    }
    if (failNext === 'terminal') throw new DomainError('validation', 'provider_rejected', 'The provider rejected the name');
    providerCalls.push(p.id);
    if (slow) await slow;
    await db.update(virtualAgents).set({ name: String(p.payload['name']) }).where(eq(virtualAgents.id, p.objectId));
  },
  makePermission: () => Permission.AGENTS_MANAGE,
};

let approvals: ApprovalService;
let decisions: ApprovalDecisionService;
beforeAll(async () => {
  f = await createApprovalFixture();
  const registry = new ApprovalRegistry().register(agentApproval).register(renameAtProvider);
  approvals = new ApprovalService(f.t.db, registry);
  decisions = new ApprovalDecisionService(f.t.db, registry);
});
afterAll(async () => {
  await f?.t.drop();
});

const worker = systemActor('approval-activation', 'deferred-test');
async function submitAndApprove(agentId: string, name: string) {
  const p = await approvals.submit(act(f.p.lead), { objectKind: 'provider_rename', objectId: agentId, action: 'UPDATE', checkerId: f.p.head.userId, reason: 'Rename', payload: { name } });
  return decisions.decide(act(f.p.head), p.id, { decision: 'APPROVE', contentHash: p.contentHash });
}

describe('deferred activation', () => {
  it('approval leaves it activating; the worker finishes it and stamps activated_at', async () => {
    const approved = await submitAndApprove(f.maya, 'Maya Prime');
    expect(approved).toMatchObject({ status: 'APPROVED', activating: true, activatedAt: null });
    expect(await decisions.finishActivation(worker, approved.id)).toBe('ACTIVATED');
    expect(providerCalls).toEqual([approved.id]);
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, approved.id));
    expect(row!.activatedAt).not.toBeNull();
    expect(await decisions.finishActivation(worker, approved.id)).toBe('SKIPPED');
    const kinds = (await f.t.db.select({ kind: approvalDecisions.kind }).from(approvalDecisions).where(eq(approvalDecisions.proposalId, approved.id))).map((d) => d.kind);
    expect(kinds).toEqual(['SUBMIT', 'APPROVE', 'ACTIVATE']);
  });

  it('a change after approval blocks it before the provider is ever called', async () => {
    const agent = await f.newAgent('Tara');
    const approved = await submitAndApprove(agent, 'Tara Two');
    await f.t.db.update(virtualAgents).set({ purpose: 'changed underneath' }).where(eq(virtualAgents.id, agent));
    const calls = providerCalls.length;
    expect(await decisions.finishActivation(worker, approved.id)).toBe('BLOCKED');
    expect(providerCalls).toHaveLength(calls);
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, approved.id));
    expect(row).toMatchObject({ status: 'BLOCKED', activatedAt: null });
    const [agentRow] = await f.t.db.select({ name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, agent));
    expect(agentRow!.name).toBe('Tara');
  });

  it('a transient provider failure is retried; a terminal one blocks', async () => {
    const agent = await f.newAgent('Uma');
    const approved = await submitAndApprove(agent, 'Uma Two');
    failNext = 'retry';
    await expect(decisions.finishActivation(worker, approved.id)).rejects.toThrow('provider timed out');
    expect(await decisions.finishActivation(worker, approved.id)).toBe('ACTIVATED');

    const other = await f.newAgent('Vik');
    const second = await submitAndApprove(other, 'Vik Two');
    failNext = 'terminal';
    expect(await decisions.finishActivation(worker, second.id)).toBe('BLOCKED');
    failNext = null;
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, second.id));
    expect(row!.blockedReason).toBe('The provider rejected the name');
  });

  it('two runners at once (queue redelivery during a slow provider call) call the provider exactly once', async () => {
    const agent = await f.newAgent('Wen');
    const approved = await submitAndApprove(agent, 'Wen Two');
    let release!: () => void;
    slow = new Promise<void>((r) => (release = r));
    const before = providerCalls.length;
    const first = decisions.finishActivation(worker, approved.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(await decisions.finishActivation(worker, approved.id)).toBe('SKIPPED');
    release();
    expect(await first).toBe('ACTIVATED');
    slow = null;
    expect(providerCalls.length - before).toBe(1);
    expect(await decisions.finishActivation(worker, approved.id)).toBe('SKIPPED');
  });
});
