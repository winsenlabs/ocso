import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { auditEvents, conversations, csatResponses, customers, evaluationRuns, interactions, promptCorrections, users, uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { MemoryQueue } from '@ocso/queue';
import { AgentService } from '../src/agents/agents.js';
import { PromptService } from '../src/agents/prompt-versions.js';
import type { ActorContext } from '../src/shared/context.js';
import { createTeam } from './support/ownership.js';
import {
  CorrectionService,
  CsatService,
  EvaluationRunInput,
  EvaluationRunService,
  ReviewInput,
  ReviewService,
  composeComponent,
  markCorrectionsApplied,
  recordCsat,
  rubricScore,
} from '../src/quality/index.js';

let t: TestDatabase;
let agentId: string;
let convId: string;
// Everyone is in the team that owns Maya (ADR-026); scoping itself is covered in agent-ownership.int.test.ts.
const TEAM = uuidv7();
const principal = (userId: string, role: Principal['role']): Principal => ({ userId, role, displayName: role === 'CS_LEAD' ? 'Anjali Rao' : 'Someone', teamIds: [TEAM], via: 'UI' });
const ctx = (p: Principal): ActorContext => ({ principal: p, correlationId: 'quality-test' });
const lead = principal('00000000-0000-7000-8000-00000000001a', 'CS_LEAD');
const exec = principal('00000000-0000-7000-8000-00000000001e', 'CS_EXEC');
const admin = principal('00000000-0000-7000-8000-00000000001d', 'PLATFORM_TECH_ADMIN');

async function conversation(state = 'RESOLVED', resolvedAt: Date | null = new Date(Date.now() - 60_000)) {
  const customerId = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: 'Priya Deshmukh' });
  const id = uuidv7();
  await t.db.insert(conversations).values({ id, customerId, agentId, type: 'SUPPORT', controlState: state, openedAt: new Date(Date.now() - 3_600_000), resolvedAt });
  const msg = (seq: number, actorType: 'CUSTOMER' | 'AGENT' | 'HUMAN') => ({ id: uuidv7(), conversationId: id, seq, actorType, direction: actorType === 'CUSTOMER' ? ('INBOUND' as const) : ('OUTBOUND' as const), visibility: 'CUSTOMER' as const, correlationId: 'x' });
  await t.db.insert(interactions).values([msg(1, 'CUSTOMER'), msg(2, 'AGENT'), msg(3, 'CUSTOMER'), msg(4, 'AGENT')]);
  return id;
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [lead, exec, admin]) await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.role}@x.test`, p.displayName, p.role]);
  await createTeam(t.db, TEAM);
  agentId = (await new AgentService(t.db).create(ctx(lead), { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM] })).id;
  convId = await conversation();
});
afterAll(async () => {
  await t?.drop();
});

describe('reviews', () => {
  it('scores the explicit rubric as the mean of four criteria', async () => {
    expect(rubricScore({ accuracy: 4, policy: 5, tone: 3, resolution: 4 })).toBe(4);
    expect(rubricScore({ accuracy: 5, policy: 4, tone: 4, resolution: 4 })).toBe(4.25);
    expect(ReviewInput.safeParse({ conversationId: convId, rubric: { accuracy: 6, policy: 5, tone: 3, resolution: 4 }, outcomeTag: 'x' }).success).toBe(false);
    expect(ReviewInput.safeParse({ conversationId: convId, rubric: { accuracy: 4, policy: 5, tone: 3 }, outcomeTag: 'x' }).success).toBe(false);
  });

  it('creates an audited review and lists it', async () => {
    const reviews = new ReviewService(t.db);
    const view = await reviews.create(ctx(lead), { conversationId: convId, rubric: { accuracy: 4, policy: 5, tone: 3, resolution: 4 }, outcomeTag: 'good handoff', notes: 'fine' });
    expect(view).toMatchObject({ score: 4, outcomeTag: 'good handoff', agent: { id: agentId, name: 'Maya' }, reviewer: { id: lead.userId }, customerName: 'Priya Deshmukh' });
    expect(await reviews.list(lead, { agentId, limit: 10 })).toHaveLength(1);
    const [audit] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'review.create'));
    expect(audit).toMatchObject({ targetId: convId, actorId: lead.userId });
    expect(reviews.rubric().outcomeTags).toContain('late escalation');
  });

  it('is limited to reviewers (reviews.manage)', async () => {
    await expect(new ReviewService(t.db).create(ctx(exec), { conversationId: convId, rubric: { accuracy: 4, policy: 5, tone: 3, resolution: 4 }, outcomeTag: 'x' })).rejects.toMatchObject({ category: 'authorization' });
    await expect(new ReviewService(t.db).list(admin, { limit: 5 })).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('prompt corrections', () => {
  const corrections = () => new CorrectionService(t.db);
  let first: string;
  let second: string;

  it('records a correction from a conversation turn and merges repeats', async () => {
    const created = await corrections().create(ctx(lead), { conversationId: convId, interactionSeq: 4, title: 'Offer reversal first', observed: 'Asked for a statement it did not need', desired: 'Check ledger, then offer reversal', componentKey: 'behavior', proposedText: '• Check the ledger before asking for a statement.' });
    expect(created.merged).toBe(false);
    first = created.id;
    const again = await corrections().create(ctx(lead), { conversationId: convId, title: 'offer REVERSAL first', observed: 'again', desired: 'same', componentKey: 'behavior' });
    expect(again).toEqual({ id: first, merged: true });
    const view = await corrections().get(lead, first);
    expect(view).toMatchObject({ agentId, occurrences: 2, status: 'OPEN', source: 'LEAD', interactionSeq: 4 });
  });

  it('validates the source turn', async () => {
    await expect(corrections().create(ctx(lead), { conversationId: convId, interactionSeq: 99, observed: 'abc', desired: 'def', componentKey: 'policies' })).rejects.toMatchObject({ code: 'interaction_not_found' });
    await expect(corrections().create(ctx(exec), { agentId, observed: 'abc', desired: 'def', componentKey: 'policies' })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('stages proposed text into the prompt draft, idempotently, without touching the live version', async () => {
    const prompts = new PromptService(t.db);
    const before = await prompts.draft(lead, agentId);
    const staged = await corrections().stage(ctx(lead), first, { mode: 'APPEND' });
    expect(staged).toEqual({ componentKey: 'behavior', changed: true });
    const draft = await prompts.draft(lead, agentId);
    expect(draft.dirty).toBe(true);
    expect(draft.components.behavior).toBe(`${before.components.behavior}\n• Check the ledger before asking for a statement.`);
    expect((await corrections().stage(ctx(lead), first, { mode: 'APPEND' })).changed).toBe(false);
    expect((await corrections().get(lead, first)).status).toBe('STAGED');
    // A REPLACE correction on another component composes onto the same draft.
    second = (await corrections().create(ctx(lead), { agentId, observed: 'promised 24h', desired: 'never promise a time', componentKey: 'policies' })).id;
    await expect(corrections().stage(ctx(lead), second, { mode: 'APPEND' })).rejects.toMatchObject({ code: 'proposed_text_required' });
    await corrections().stage(ctx(lead), second, { mode: 'REPLACE', proposedText: '• Never state a resolution time for disputes.' });
    const both = await prompts.draft(lead, agentId);
    expect(both.components.policies).toBe('• Never state a resolution time for disputes.');
    expect(both.components.behavior).toContain('Check the ledger');
    const active = await prompts.versions(lead, agentId);
    expect(active).toHaveLength(1); // nothing versioned or activated invisibly
    expect(composeComponent('a', 'b', 'APPEND')).toBe('a\nb');
  });

  it('marks corrections APPLIED when a version that includes them is created', async () => {
    const version = await new PromptService(t.db).createVersionFromDraft(ctx(lead), agentId, { reason: 'Apply corrections', correctionIds: [first, second] });
    // Creating the version applies them; an explicit call is then a no-op.
    const rows = await t.db.select().from(promptCorrections).where(eq(promptCorrections.resultingVersionId, version.id));
    expect(rows.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(await markCorrectionsApplied(t.db, version.id)).toBe(0); // idempotent
    await expect(corrections().stage(ctx(lead), first, { mode: 'APPEND' })).rejects.toMatchObject({ code: 'correction_not_open' });
  });

  it('rejects open corrections once', async () => {
    const { id } = await corrections().create(ctx(lead), { agentId, observed: 'too long replies', desired: 'shorter', componentKey: 'channel_constraints' });
    await corrections().reject(ctx(lead), id, { reason: 'not reproducible' });
    expect((await corrections().get(lead, id)).status).toBe('REJECTED');
    await expect(corrections().reject(ctx(lead), id, {})).rejects.toMatchObject({ category: 'conflict' });
    expect((await corrections().list(lead, { agentId, limit: 10 })).map((c) => c.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED']);
  });
});

describe('csat', () => {
  it('records one response per resolution cycle and keeps the latest score on the conversation', async () => {
    const r = await recordCsat(t.db, convId, 4, 'quick');
    expect(r).toMatchObject({ score: 4, handledByHuman: false });
    await expect(recordCsat(t.db, convId, 5, null)).rejects.toMatchObject({ code: 'csat_already_recorded' });
    // Reopened and resolved again later: a new response is allowed.
    await t.db.update(conversations).set({ resolvedAt: new Date(Date.now() + 1_000) }).where(eq(conversations.id, convId));
    const later = await recordCsat(t.db, convId, 2, null, { now: new Date(Date.now() + 2_000) });
    expect(later.score).toBe(2);
    const [row] = await t.db.select({ csat: conversations.csatScore }).from(conversations).where(eq(conversations.id, convId));
    expect(row!.csat).toBe(2);
    await expect(recordCsat(t.db, convId, 9, null)).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('marks human-handled conversations and enforces staff permissions', async () => {
    const humanConv = await conversation('HUMAN_ACTIVE', null);
    await t.db.insert(interactions).values({ id: uuidv7(), conversationId: humanConv, seq: 5, actorType: 'HUMAN', actorId: exec.userId, direction: 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'x' });
    const svc = new CsatService(t.db);
    const recorded = await svc.record(ctx(exec), humanConv, { score: 5 });
    expect(recorded.handledByHuman).toBe(true);
    expect(await svc.list(humanConv)).toEqual([expect.objectContaining({ score: 5, handledByHuman: true, agentId })]);
    await expect(svc.record(ctx(admin), humanConv, { score: 5 })).rejects.toMatchObject({ category: 'authorization' });
    const [audit] = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'csat.record'));
    expect(audit).toMatchObject({ targetId: humanConv, actorId: exec.userId });
    expect(await t.db.select().from(csatResponses)).toHaveLength(3);
  });
});

describe('evaluation runs', () => {
  it('queues a run over the prompt draft and publishes evaluation.run', async () => {
    const queue = new MemoryQueue();
    const svc = new EvaluationRunService(t.db, queue);
    await new PromptService(t.db).saveDraft(ctx(lead), agentId, { ...(await new PromptService(t.db).draft(lead, agentId)).components, behavior: 'DRAFT BEHAVIOR' });
    const run = await svc.create(ctx(lead), EvaluationRunInput.parse({ agentId, caseCount: 10 }));
    expect(run).toMatchObject({ status: 'QUEUED', caseCount: 10, createdByName: 'Anjali Rao', baselineVersion: 1 }); // v2 exists but v1 is active
    expect(run.candidateComponents['behavior']).toBe('DRAFT BEHAVIOR');
    expect(queue.pending('evaluation.run')).toBe(1);
    const explicit = await svc.create(ctx(lead), EvaluationRunInput.parse({ agentId, source: 'COMPONENTS', components: { escalation: 'ESCALATE MORE' } }));
    expect(explicit.candidateComponents).toMatchObject({ escalation: 'ESCALATE MORE' });
    expect(explicit.candidateComponents['behavior']).not.toBe('DRAFT BEHAVIOR'); // merged over the active version, not the draft
    expect((await svc.list(lead, { agentId, limit: 5 })).map((r) => r.id)).toEqual([explicit.id, run.id]);
    expect(await svc.results(lead, run.id, { changedOnly: false, limit: 10 })).toEqual([]);
  });

  it('requires evaluations.run and validates the source', async () => {
    const svc = new EvaluationRunService(t.db, new MemoryQueue());
    await expect(svc.create(ctx(exec), EvaluationRunInput.parse({ agentId }))).rejects.toMatchObject({ category: 'authorization' });
    expect(EvaluationRunInput.safeParse({ agentId, source: 'COMPONENTS' }).success).toBe(false);
    expect(await t.db.select().from(evaluationRuns)).toHaveLength(2);
    expect((await t.db.select().from(users)).length).toBe(3);
  });
});
