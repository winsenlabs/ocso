import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKeyPem, loadSigningKey, publicKeyOf } from '@ocso/audit-store';
import { exceptionReports, uuidv7 } from '@ocso/db';
import { ExceptionService, readZip, verifyExportBundle, type ExceptionReportContent } from '../../src/index.js';
import { act } from '../approvals/fixture.js';
import { createExceptionFixture, type ExceptionFixture } from './fixture.js';

/**
 * The weekly chain, regeneration and the signer's attestation (ADR-033
 * amendments): no report before setup; each week starts where the last ended
 * (back-fill after an outage, a bridge across a time-zone change, never an
 * overlap); a failed draft is superseded, never edited; a sign-off states what
 * it attests; a signed report stays verifiable after the key is rotated.
 */

const NOW = new Date('2026-09-23T10:00:00.000Z');
let f: ExceptionFixture;
const at = (iso: string) => new ExceptionService(f.t.db, f.registry, { signer: f.signer, now: () => new Date(iso) });
const weeklies = () =>
  f.t.db
    .select({ id: exceptionReports.id, start: exceptionReports.periodStart, end: exceptionReports.periodEnd, status: exceptionReports.status })
    .from(exceptionReports)
    .where(eq(exceptionReports.kind, 'WEEKLY'))
    .orderBy(asc(exceptionReports.periodStart));

beforeAll(async () => {
  f = await createExceptionFixture(NOW);
});

afterAll(async () => {
  await f?.t.drop();
});

describe('the weekly chain', () => {
  it('generates nothing before setup is complete', async () => {
    await f.t.pool.query(`UPDATE deployment_settings SET setup_completed_at = NULL`);
    expect(await f.service.generateWeekly()).toMatchObject({ id: null, created: false, skipped: 'setup_incomplete', generated: [] });
    expect(await weeklies()).toEqual([]);
    await f.t.pool.query(`UPDATE deployment_settings SET setup_completed_at = $1, timezone = 'UTC'`, [new Date('2026-07-01T00:00:00Z')]);
  });

  it('the first report is the last complete week; after an outage every missed week is filled, in order', async () => {
    const first = await f.service.generateWeekly();
    expect(first).toMatchObject({ created: true, period: { start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') } });
    // The worker is down for three weeks.
    const after = await at('2026-10-14T09:00:00Z').generateWeekly();
    expect(after.generated).toHaveLength(3);
    const rows = await weeklies();
    expect(rows.map((r) => r.start.toISOString())).toEqual(['2026-09-14T00:00:00.000Z', '2026-09-21T00:00:00.000Z', '2026-09-28T00:00:00.000Z', '2026-10-05T00:00:00.000Z']);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.start).toEqual(rows[i - 1]!.end);
    expect((await at('2026-10-14T10:00:00Z').generateWeekly()).created).toBe(false);
  });

  it('a time-zone change makes one bridging period: no gap, no week covered twice', async () => {
    await f.t.pool.query(`UPDATE deployment_settings SET timezone = 'Asia/Kolkata'`);
    const bridged = await at('2026-10-20T09:00:00Z').generateWeekly();
    expect(bridged.period).toEqual({ start: new Date('2026-10-12T00:00:00Z'), end: new Date('2026-10-18T18:30:00Z') });
    const next = await at('2026-10-27T09:00:00Z').generateWeekly();
    expect(next.period).toEqual({ start: new Date('2026-10-18T18:30:00Z'), end: new Date('2026-10-25T18:30:00Z') });
  });

  it('the database refuses an overlapping weekly report', async () => {
    const [row] = await f.t.db.select().from(exceptionReports).where(eq(exceptionReports.kind, 'WEEKLY')).limit(1);
    await expect(
      f.t.pool.query(`INSERT INTO exception_reports (id, kind, period_start, period_end, content, content_hash) VALUES ($1, 'WEEKLY', $2, $3, '{}'::jsonb, 'x')`, [
        uuidv7(),
        new Date(row!.periodStart.getTime() + 3_600_000),
        new Date(row!.periodEnd.getTime() + 3_600_000),
      ]),
    ).rejects.toThrow(/exception_reports_weekly_no_overlap/);
  });
});

describe('regenerating a draft', () => {
  it('supersedes the draft (kept, pointing at its successor) and the chain continues from the successor', async () => {
    const [oldest] = await weeklies();
    const fresh = await f.service.regenerate(act(f.p.head), oldest!.id, { reason: 'the audit store timed out on Monday' });
    expect(fresh).toMatchObject({ kind: 'WEEKLY', status: 'DRAFT', periodStart: oldest!.start.toISOString(), periodEnd: oldest!.end.toISOString() });
    const old = await f.service.get(f.p.head, oldest!.id);
    expect(old).toMatchObject({ status: 'SUPERSEDED', supersededBy: fresh.id, canSign: false, signBlocked: 'superseded', canRegenerate: false });
    await expect(f.service.sign(act(f.p.head), oldest!.id, { contentHash: old.contentHash })).rejects.toMatchObject({ code: 'report_superseded' });
    await expect(f.service.regenerate(act(f.p.head), oldest!.id, { reason: 'again' })).rejects.toMatchObject({ code: 'report_superseded' });
    await expect(f.service.regenerate(act(f.p.tech), fresh.id, { reason: 'Tech cannot' })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('the trigger allows only DRAFT → SUPERSEDED with a successor, and freezes it', async () => {
    const [superseded] = (await weeklies()).filter((r) => r.status === 'SUPERSEDED');
    const q = (text: string, params: unknown[] = []) => f.t.pool.query(text, params);
    await expect(q(`UPDATE exception_reports SET status = 'DRAFT', superseded_by = NULL WHERE id = $1`, [superseded!.id])).rejects.toThrow(/immutable/);
    const draft = (await weeklies()).find((r) => r.status === 'DRAFT')!;
    await expect(q(`UPDATE exception_reports SET status = 'SUPERSEDED' WHERE id = $1`, [draft.id])).rejects.toThrow(/superseded_ck/);
    await expect(q(`UPDATE exception_reports SET status = 'SUPERSEDED', superseded_by = $2, content = '{}'::jsonb WHERE id = $1`, [draft.id, uuidv7()])).rejects.toThrow(/only be signed or superseded/);
  });
});

describe('the signer’s attestation', () => {
  it('a report whose checks failed is signed only with that acknowledged; the flag is signed and audited', async () => {
    const broken = { ...f.registry, all: () => [{ ...f.registry.get('agent'), liveObjects: () => Promise.reject(new Error('boom')) }] };
    const svc = new ExceptionService(f.t.db, broken as never, { signer: f.signer, now: () => NOW });
    const report = await svc.generateAdhoc(act(f.p.head), { periodStart: '2026-09-10T00:00:00Z', periodEnd: '2026-09-17T00:00:00Z' });
    expect(report.attestationRequired).toContain('failed_checks');
    await expect(svc.sign(act(f.p.head), report.id, { contentHash: report.contentHash })).rejects.toMatchObject({ code: 'attestation_required', details: { required: ['failed_checks'] } });
    const signed = await svc.sign(act(f.p.head), report.id, { contentHash: report.contentHash, acknowledge: ['failed_checks'], note: 'Audit store was down' });
    expect(signed).toMatchObject({ status: 'SIGNED', attestation: ['failed_checks'], verification: 'VALID' });
  });

  it('a period older than the operational retention (14 days) is flagged incomplete_data', async () => {
    const report = await f.service.generateAdhoc(act(f.p.head), { periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-08T00:00:00Z' });
    expect(report.attestationRequired).toEqual(['incomplete_data']);
    const delivery = report.content.sections.find((s) => s.id === 'delivery_failures')!;
    expect(delivery.coverage).toEqual({ dataFrom: '2026-09-09T10:00:00.000Z', complete: false });
    expect(report.totals.incompleteChecks).toBeGreaterThan(0);
  });

  it('a Head who approved their own change (bootstrap) in the period self-attests', async () => {
    await f.seed.bootstrap(f.p.headLoans, new Date('2026-09-12T10:00:00Z'));
    const report = await f.service.generateAdhoc(act(f.p.headLoans), { periodStart: '2026-09-10T00:00:00Z', periodEnd: '2026-09-17T00:00:00Z' });
    expect(report.attestationRequired).toEqual(['self_attested']);
    // Another signer, not named in it, attests nothing.
    expect((await f.service.get(f.p.head, report.id)).attestationRequired).toEqual([]);
    const signed = await f.service.sign(act(f.p.headLoans), report.id, { contentHash: report.contentHash, acknowledge: ['self_attested'] });
    expect(signed.attestation).toEqual(['self_attested']);
    const { zip } = await f.service.exportBundle(act(f.p.headLoans), report.id);
    expect(readZip(zip).get('signed-message.txt')!.toString()).toContain('\nattestation:self_attested\nnote-sha256:none');
  });

  it('a signed report stays verifiable and exportable after the signing key is rotated away', async () => {
    const signed = (await f.service.list(f.p.head, { status: 'SIGNED', limit: 5 })).rows[0]!;
    const rotated = new ExceptionService(f.t.db, f.registry, { signer: loadSigningKey(generateSigningKeyPem()), now: () => NOW });
    expect(await rotated.get(f.p.head, signed.id)).toMatchObject({ verification: 'VALID', keyTrust: 'UNKNOWN' });
    const { zip } = await rotated.exportBundle(act(f.p.head), signed.id);
    const manifest = JSON.parse(readZip(zip).get('manifest.json')!.toString()) as { report: { keyTrust: string } };
    expect(manifest.report.keyTrust).toBe('UNKNOWN');
    expect(verifyExportBundle(zip, [publicKeyOf(f.signer)])).toMatchObject({ ok: true });
    // Without a key the server says why it cannot sign.
    const keyless = new ExceptionService(f.t.db, f.registry, { now: () => NOW });
    const draft = (await keyless.list(f.p.head, { status: 'DRAFT', limit: 1 })).rows[0]!;
    expect(await keyless.get(f.p.head, draft.id)).toMatchObject({ canSign: false, signBlocked: 'signing_key_unavailable' });
  });
});

describe('the report’s own control', () => {
  it('lists weekly reports left unsigned and drafts whose checks failed', async () => {
    const live = await at('2026-10-28T09:00:00Z').live(f.p.head);
    const hygiene = live.content.sections.find((s) => s.id === 'report_hygiene')!;
    expect(hygiene.items.some((i) => i.title.includes('is not signed'))).toBe(true);
    const content = (await f.t.db.select().from(exceptionReports).where(and(eq(exceptionReports.kind, 'WEEKLY'), eq(exceptionReports.status, 'DRAFT'))))[0]!.content as unknown as ExceptionReportContent;
    expect(content.kind).toBe('WEEKLY');
    expect(content.format).toBe('ocso-exception-report/2');
  });

  it('flags a weekly report that was never generated', async () => {
    const late = await at('2026-11-20T09:00:00Z').live(f.p.head);
    expect(late.content.sections.find((s) => s.id === 'report_hygiene')!.items.some((i) => i.title.startsWith('No weekly report'))).toBe(true);
  });
});
