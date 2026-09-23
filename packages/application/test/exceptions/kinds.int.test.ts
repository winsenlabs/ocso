import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeExceptions, EXCEPTION_KINDS, type ExceptionReportContent, type ExceptionSection } from '../../src/index.js';
import { act } from '../approvals/fixture.js';
import { createExceptionFixture, type ExceptionFixture } from './fixture.js';

/**
 * Each exception kind computed on seeded data (PM/research/11 §7): one
 * occurrence inside the period, one outside it where the kind is time-bound,
 * and the kinds that are state (live without approval, open aged approvals,
 * standing grants, shipping lag) judged as of `now`.
 */

const NOW = new Date('2026-09-23T10:00:00.000Z');
const PERIOD = { start: new Date('2026-09-14T00:00:00.000Z'), end: new Date('2026-09-21T00:00:00.000Z') };
const IN = new Date('2026-09-16T12:00:00.000Z');
const BEFORE = new Date('2026-09-10T12:00:00.000Z');

let f: ExceptionFixture;
let report: ExceptionReportContent;
/** Written through the services, so stamped with the wall clock: judged over a period around it. */
let recent: ExceptionReportContent;
const ids: Record<string, string> = {};
const section = (id: string): ExceptionSection => report.sections.find((s) => s.id === id)!;
const objectIds = (id: string) => section(id).items.map((i) => i.objectId);

beforeAll(async () => {
  f = await createExceptionFixture(NOW);
  const { seed, p } = f;
  ids.rogue = await seed.liveAgentWithoutApproval('Rogue');
  // Taken live through a real approval: neither the agent nor its active prompt is an exception.
  ids.approvedAgent = await f.newAgent('Vetted');
  const proposed = await f.submit(p.lead, p.head, { objectId: ids.approvedAgent, action: 'ACTIVATE' });
  await f.approve(p.head, proposed.id);
  ids.aged = await seed.agedProposal(p.lead, p.head, 100);
  ids.fresh = await seed.agedProposal(p.lead, p.head, 5);
  ids.bootstrapIn = await seed.bootstrap(p.head, IN);
  ids.bootstrapBefore = await seed.bootstrap(p.head, BEFORE);
  // A rejected go-live sent again unchanged (through the services: wall-clock time).
  ids.resubmitAgent = await f.newAgent('Shopper');
  const first = await f.submit(p.lead, p.head, { objectId: ids.resubmitAgent, action: 'ACTIVATE' });
  await f.decisions.decide(act(p.head), first.id, { decision: 'REJECT', reason: 'Not ready', contentHash: first.contentHash, dependencyHash: first.dependencyHash });
  ids.resubmitted = (await f.submit(p.lead, p.head2, { objectId: ids.resubmitAgent, action: 'ACTIVATE' })).id;
  ids.grant = await seed.grantWithoutApproval(p.service, 'agents.manage');
  await seed.skippedApprovalAudit(p.lead);
  const inRoute = await seed.routing(IN, 'FALLBACK', f.team.cards);
  ids.fallbackRouter = inRoute.routerId;
  ids.ruleRouter = (await seed.routing(IN, 'RULE', null)).routerId;
  ids.oldRouter = (await seed.routing(BEFORE, 'TIMEOUT', null)).routerId;
  ids.template = await seed.rejectedTemplate(IN);
  ids.oldTemplate = await seed.rejectedTemplate(BEFORE);
  const failed = await seed.failedDeliveries(IN);
  ids.failedChannel = failed.channelId;
  ids.subscription = failed.subscriptionId;
  ids.shipIncident = await seed.auditIncident('SHIP_FAILED', IN, new Date(IN.getTime() + 3_600_000));
  ids.oldIncident = await seed.auditIncident('SHIP_FAILED', BEFORE, new Date(BEFORE.getTime() + 3_600_000));
  ids.chainIncident = await seed.auditIncident('CHAIN_BROKEN', BEFORE, null);
  await seed.unshippedAudit(new Date(NOW.getTime() - 10 * 60_000));
  ids.verification = await seed.failedVerification(IN);
  report = await computeExceptions(f.t.db, f.registry, { period: PERIOD, now: NOW, mode: 'REPORT', timezone: 'Asia/Kolkata', approvalAgeWarningHours: 72 });
  const wall = Date.now();
  recent = await computeExceptions(f.t.db, f.registry, { period: { start: new Date(wall - 3_600_000), end: new Date(wall + 3_600_000) }, now: new Date(wall), mode: 'REPORT', timezone: 'UTC', approvalAgeWarningHours: 72 });
});
const recentIds = (id: string) => recent.sections.find((s) => s.id === id)!.items.map((i) => i.objectId);

afterAll(async () => {
  await f?.t.drop();
});

describe('exception kinds', () => {
  it('runs every registered kind and none fails', () => {
    expect(report.sections.map((s) => s.id)).toEqual(EXCEPTION_KINDS.map((k) => k.id));
    expect(report.sections.filter((s) => s.error)).toEqual([]);
    expect(report.totals.failedChecks).toBe(0);
  });

  it('live_without_approval: a live agent with no approval, not one taken live through one (nor its prompt)', async () => {
    expect(objectIds('live_without_approval')).toContain(ids.rogue);
    expect(objectIds('live_without_approval')).not.toContain(ids.approvedAgent);
    const vetted = await f.agents.get(f.p.head, ids.approvedAgent!);
    expect(objectIds('live_without_approval')).not.toContain(vetted.activePromptVersionId);
    const rogue = section('live_without_approval').items.find((i) => i.objectId === ids.rogue)!;
    expect(rogue).toMatchObject({ objectKind: 'agent', teamIds: [f.team.cards] });
    expect(rogue.title).toContain('Rogue');
  });

  it('bootstrap_approvals: self-approvals in the period only', () => {
    expect(objectIds('bootstrap_approvals')).toEqual([ids.bootstrapIn]);
    expect(section('bootstrap_approvals').items[0]!.href).toBe(`/approvals?box=decided&approval=${ids.bootstrapIn}`);
  });

  it('approvals_aged: open longer than the warning, not a fresh one', () => {
    expect(objectIds('approvals_aged')).toContain(ids.aged);
    expect(objectIds('approvals_aged')).not.toContain(ids.fresh);
  });

  it('resubmitted_unchanged: the rejected change sent again', () => {
    expect(recentIds('resubmitted_unchanged')).toEqual([ids.resubmitted]);
    expect(objectIds('resubmitted_unchanged')).toEqual([]);
  });

  it('permission_bypass: a standing grant with no approval and a skipped-approval audit event', () => {
    const items = section('permission_bypass').items;
    expect(items.find((i) => i.objectId === f.p.service.userId)?.title).toContain('agents.manage');
    expect(items.find((i) => i.objectId === f.p.service.userId)?.teamIds).toEqual([f.team.cards]);
    // The skipped approval happened now (wall clock): in the recent period, not the report's.
    expect(items.some((i) => i.objectId === f.p.lead.userId)).toBe(false);
    const skipped = recent.sections.find((s) => s.id === 'permission_bypass')!.items.find((i) => i.objectId === f.p.lead.userId);
    expect(skipped?.title).toContain('development flag');
  });

  it('routing_fallback: fallbacks from the timeline in the period grouped per router, blocked routing and refused messages', () => {
    const items = section('routing_fallback').items;
    const fallback = items.find((i) => i.objectId === ids.fallbackRouter && i.title.includes('fell back'))!;
    expect(fallback).toMatchObject({ count: 1, teamIds: [f.team.cards] });
    expect(items.some((i) => i.objectId === ids.ruleRouter && i.title.includes('fell back'))).toBe(false);
    expect(items.some((i) => i.objectId === ids.oldRouter)).toBe(false);
    expect(items.some((i) => i.objectId === ids.fallbackRouter && i.title.includes('could not place'))).toBe(true);
    expect(items.some((i) => i.objectKind === 'channel' && i.title.includes('no_router'))).toBe(true);
  });

  it('templates_rejected: in a report, those rejected during the period (from the audit trail)', () => {
    expect(objectIds('templates_rejected')).toEqual([ids.template]);
  });

  it('templates_rejected: a rejection stays in the report after the template is fixed', async () => {
    await f.t.pool.query(`UPDATE message_templates SET status = 'APPROVED', rejection_reason = NULL WHERE id = $1`, [ids.template]);
    const again = await computeExceptions(f.t.db, f.registry, { period: PERIOD, now: NOW, mode: 'REPORT', timezone: 'UTC', approvalAgeWarningHours: 72 });
    expect(again.sections.find((s) => s.id === 'templates_rejected')!.items.map((i) => i.objectId)).toEqual([ids.template]);
    await f.t.pool.query(`UPDATE message_templates SET status = 'REJECTED', rejection_reason = 'INVALID_FORMAT' WHERE id = $1`, [ids.template]);
  });

  it('routing_fallback: a fallback stays in the report after the conversation is routed again', async () => {
    await f.t.pool.query(`UPDATE conversation_routing SET outcome = 'RULE' WHERE router_id = $1`, [ids.fallbackRouter]);
    const again = await computeExceptions(f.t.db, f.registry, { period: PERIOD, now: NOW, mode: 'REPORT', timezone: 'UTC', approvalAgeWarningHours: 72 });
    expect(again.sections.find((s) => s.id === 'routing_fallback')!.items.some((i) => i.objectId === ids.fallbackRouter && i.title.includes('fell back'))).toBe(true);
  });

  it('delivery_failures: failed messages grouped per channel and error, failed webhooks', () => {
    const items = section('delivery_failures').items;
    expect(items.find((i) => i.objectId === ids.failedChannel)).toMatchObject({ count: 2 });
    expect(items.find((i) => i.objectId === ids.subscription)?.detail).toContain('HTTP 500');
  });

  it('audit_shipping: incidents overlapping the period and the current lag', () => {
    const items = section('audit_shipping').items;
    expect(items.map((i) => i.objectId)).toContain(ids.shipIncident);
    expect(items.map((i) => i.objectId)).not.toContain(ids.oldIncident);
    expect(items.find((i) => i.objectKind === 'audit_store')?.title).toContain('not yet in the audit store');
  });

  it('audit_chain: an open break from before the period and a failed full verification in it', () => {
    expect(objectIds('audit_chain')).toEqual(expect.arrayContaining([ids.chainIncident, ids.verification]));
    expect(section('audit_chain').items.find((i) => i.objectId === ids.chainIncident)?.detail).toContain('#10–12');
  });

  it('live mode lists every template currently rejected', async () => {
    const live = await computeExceptions(f.t.db, f.registry, { period: PERIOD, now: NOW, mode: 'LIVE', timezone: 'UTC', approvalAgeWarningHours: 72 });
    expect(live.sections.find((s) => s.id === 'templates_rejected')!.items.map((i) => i.objectId).sort()).toEqual([ids.template, ids.oldTemplate].sort());
  });

  it('a check that fails is recorded in its section, the others still run', async () => {
    const broken = { ...f.registry, all: () => [{ ...f.registry.get('agent'), liveObjects: () => Promise.reject(new Error('descriptor exploded: SELECT secret')) }] };
    const out = await computeExceptions(f.t.db, broken as never, { period: PERIOD, now: NOW, mode: 'REPORT', timezone: 'UTC', approvalAgeWarningHours: 72 });
    // Only the error's class is stored (the report is immutable and exported); both checks that walk descriptors fail.
    expect(out.sections.find((s) => s.id === 'live_without_approval')).toMatchObject({ error: 'check_failed', items: [], total: 0 });
    expect(out.sections.find((s) => s.id === 'installed_only')).toMatchObject({ error: 'check_failed' });
    expect(out.totals.failedChecks).toBe(2);
    expect(JSON.stringify(out)).not.toContain('SELECT secret');
    expect(out.sections.find((s) => s.id === 'bootstrap_approvals')!.items).toHaveLength(1);
  });
});
