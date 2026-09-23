import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKeyPem, loadSigningKey, publicKeyOf } from '@ocso/audit-store';
import { auditEvents, exceptionReports, outboxEvents } from '@ocso/db';
import { ExceptionService, readZip, verifyExportBundle, verifyReportSignature, writeZip, type ExceptionReportContent } from '../../src/index.js';
import { act } from '../approvals/fixture.js';
import { createExceptionFixture, type ExceptionFixture } from './fixture.js';

/**
 * Weekly generation (idempotent per period), scoping, signing, immutability and
 * the signed export (PM/research/11 §7, ADR-033).
 */

// A Wednesday; in Asia/Kolkata the last complete week is Mon 14 Sep 00:00 IST → Mon 21 Sep 00:00 IST.
const NOW = new Date('2026-09-23T10:00:00.000Z');
const IN = new Date('2026-09-16T12:00:00.000Z');

let f: ExceptionFixture;
let weeklyId: string;

beforeAll(async () => {
  f = await createExceptionFixture(NOW);
  await f.t.pool.query(`UPDATE deployment_settings SET timezone = 'Asia/Kolkata'`);
  // One team item (Cards: the routing fallback's queue) and platform-wide ones.
  await f.seed.routing(IN, 'FALLBACK', f.team.cards);
  await f.seed.rejectedTemplate(IN);
  await f.seed.auditIncident('SHIP_FAILED', IN, new Date(IN.getTime() + 60_000));
  weeklyId = (await f.service.generateWeekly('corr-weekly')).id!;
});

afterAll(async () => {
  await f?.t.drop();
});

describe('weekly generation', () => {
  it('covers the last complete Monday-to-Monday week in the deployment time zone', async () => {
    const report = await f.service.get(f.p.head, weeklyId);
    expect(report).toMatchObject({ kind: 'WEEKLY', status: 'DRAFT', periodStart: '2026-09-13T18:30:00.000Z', periodEnd: '2026-09-20T18:30:00.000Z', generatedBy: null });
    expect(report.content.period.timezone).toBe('Asia/Kolkata');
    expect(report.totals.items).toBeGreaterThan(0);
  });

  it('is idempotent per period: a second run (or a second leader) creates nothing and announces nothing', async () => {
    const again = await f.service.generateWeekly('corr-weekly-2');
    expect(again).toMatchObject({ id: weeklyId, created: false });
    const second = new ExceptionService(f.t.db, f.registry, { now: () => NOW });
    expect((await second.generateWeekly()).id).toBe(weeklyId);
    expect(await f.t.db.select().from(exceptionReports).where(eq(exceptionReports.kind, 'WEEKLY'))).toHaveLength(1);
    const ready = await f.t.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'exception_report.ready'));
    expect(ready).toHaveLength(1);
    expect(ready[0]!.payload).toMatchObject({ reportId: weeklyId, kind: 'WEEKLY' });
    const generated = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'exception_report.generate'), eq(auditEvents.targetId, weeklyId)));
    expect(generated).toHaveLength(1);
  });

  it('a new week makes a new report', async () => {
    const later = new ExceptionService(f.t.db, f.registry, { now: () => new Date('2026-09-29T02:00:00.000Z') });
    const next = await later.generateWeekly();
    expect(next.created).toBe(true);
    expect(next.period!.start.toISOString()).toBe('2026-09-20T18:30:00.000Z');
  });
});

describe('scoping', () => {
  it('a signer sees the whole report; an exceptions.read holder their teams’ items and platform-wide ones', async () => {
    const whole = await f.service.get(f.p.head, weeklyId);
    const scoped = await f.service.get(f.p.tech, weeklyId);
    const loansHead = await f.service.get({ ...f.p.tech, teamIds: [f.team.loans] }, weeklyId);
    const all = whole.content.sections.flatMap((s) => s.items);
    const teamItem = all.find((i) => i.teamIds.includes(f.team.cards))!;
    expect(whole.scoped).toBe(false);
    expect(scoped.scoped).toBe(true);
    expect(scoped.content.sections.flatMap((s) => s.items).some((i) => i.objectId === teamItem.objectId && i.teamIds.length)).toBe(false);
    expect(scoped.content.sections.flatMap((s) => s.items).every((i) => i.teamIds.length === 0)).toBe(true);
    expect(loansHead.totals.items).toBeLessThan(whole.totals.items);
    const cardsReader = await f.service.get({ ...f.p.tech, teamIds: [f.team.cards] }, weeklyId);
    expect(cardsReader.content.sections.flatMap((s) => s.items).some((i) => i.teamIds.includes(f.team.cards))).toBe(true);
    // A scoped reader never gets the signature (it covers content they cannot see) nor the export.
    expect(scoped).toMatchObject({ canSign: false, canExport: false, signature: null });
  });

  it('people without exceptions.read are refused, and only signers sign, export or create ad-hoc reports', async () => {
    await expect(f.service.get(f.p.lead, weeklyId)).rejects.toMatchObject({ category: 'authorization' });
    await expect(f.service.live(f.p.service)).rejects.toMatchObject({ category: 'authorization' });
    const report = await f.service.get(f.p.tech, weeklyId);
    await expect(f.service.sign(act(f.p.tech), weeklyId, { contentHash: report.contentHash })).rejects.toMatchObject({ category: 'authorization' });
    await expect(f.service.exportBundle(act(f.p.tech), weeklyId)).rejects.toMatchObject({ category: 'authorization' });
  });

  it('the live view is scoped the same way', async () => {
    const whole = await f.service.live(f.p.head);
    const scoped = await f.service.live(f.p.tech);
    expect(whole.scoped).toBe(false);
    expect(scoped.content.sections.flatMap((s) => s.items).every((i) => i.teamIds.length === 0)).toBe(true);
  });
});

describe('signing', () => {
  it('refuses a signature over content the signer was not shown', async () => {
    await expect(f.service.sign(act(f.p.head), weeklyId, { contentHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'report_changed' });
  });

  it('signs with the audit key; the signature verifies and fails when the content, period or signer changes', async () => {
    const shown = await f.service.get(f.p.head, weeklyId);
    f.now.value = new Date('2026-09-23T11:00:00.123Z');
    const signed = await f.service.sign(act(f.p.head), weeklyId, { contentHash: shown.contentHash, note: 'Reviewed with the risk team' });
    expect(signed).toMatchObject({ status: 'SIGNED', signedAt: '2026-09-23T11:00:00.123Z', signedBy: { id: f.p.head.userId }, keyId: f.signer.keyId, signNote: 'Reviewed with the risk team', verification: 'VALID', canExport: true });
    const [row] = await f.t.db.select().from(exceptionReports).where(eq(exceptionReports.id, weeklyId));
    const base = {
      id: row!.id,
      period: { start: row!.periodStart, end: row!.periodEnd },
      contentHash: row!.contentHash,
      signedBy: row!.signedBy!,
      signedAt: row!.signedAt!,
      attestation: row!.attestation,
      signNote: row!.signNote,
      content: row!.content,
      keyId: row!.keyId!,
      signature: row!.signature!,
    };
    expect(row!.publicKeyPem).toBe(publicKeyOf(f.signer).publicKeyPem);
    const keys = [publicKeyOf(f.signer)];
    expect(verifyReportSignature(base, keys)).toBe('VALID');
    const altered = structuredClone(row!.content) as unknown as ExceptionReportContent;
    altered.sections[0]!.items = [];
    expect(verifyReportSignature({ ...base, content: altered as never }, keys)).toBe('CONTENT_CHANGED');
    expect(verifyReportSignature({ ...base, signedBy: f.p.head2.userId }, keys)).toBe('INVALID');
    expect(verifyReportSignature({ ...base, period: { start: new Date(0), end: base.period.end } }, keys)).toBe('INVALID');
    // The note and the attestation are signed too.
    expect(verifyReportSignature({ ...base, signNote: 'No issues found' }, keys)).toBe('INVALID');
    expect(verifyReportSignature({ ...base, attestation: ['self_attested'] }, keys)).toBe('INVALID');
    expect(verifyReportSignature(base, [publicKeyOf(loadSigningKey(generateSigningKeyPem()))])).toBe('UNKNOWN_KEY');
  });

  it('the sign-off is audited', async () => {
    const [audit] = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'exception_report.sign'), eq(auditEvents.targetId, weeklyId)));
    expect(audit).toMatchObject({ actorId: f.p.head.userId, targetType: 'exception_report' });
    expect(audit!.after).toMatchObject({ keyId: f.signer.keyId, note: 'Reviewed with the risk team' });
  });

  it('a signed report is not signed twice', async () => {
    const shown = await f.service.get(f.p.head2, weeklyId);
    await expect(f.service.sign(act(f.p.head2), weeklyId, { contentHash: shown.contentHash })).rejects.toMatchObject({ code: 'report_signed' });
  });
});

describe('immutability (triggers)', () => {
  it('a signed report cannot be changed, a draft only signed, and no report deleted or truncated', async () => {
    const draft = (await f.service.generateAdhoc(act(f.p.head), { periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-08T00:00:00Z' })).id;
    const q = (text: string, params: unknown[] = []) => f.t.pool.query(text, params);
    await expect(q(`UPDATE exception_reports SET sign_note = 'edited' WHERE id = $1`, [weeklyId])).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE exception_reports SET content = '{}'::jsonb WHERE id = $1`, [draft])).rejects.toThrow(/only be signed/);
    await expect(
      q(`UPDATE exception_reports SET status = 'SIGNED', signed_at = now(), signed_by = $2, signature = 'x', key_id = 'k', content_hash = 'forged' WHERE id = $1`, [draft, f.p.head.userId]),
    ).rejects.toThrow(/only be signed/);
    await expect(q(`DELETE FROM exception_reports WHERE id = $1`, [draft])).rejects.toThrow(/never deleted/);
    await expect(q(`DELETE FROM exception_reports WHERE id = $1`, [weeklyId])).rejects.toThrow(/never deleted/);
    await expect(q(`TRUNCATE exception_reports`)).rejects.toThrow(/never deleted/);
  });

  it('ad-hoc reports cover ended periods within the local audit window only', async () => {
    await expect(f.service.generateAdhoc(act(f.p.head), { periodStart: '2026-09-22T00:00:00Z', periodEnd: '2026-09-24T00:00:00Z' })).rejects.toMatchObject({ code: 'period_not_over' });
    await expect(f.service.generateAdhoc(act(f.p.head), { periodStart: '2026-05-01T00:00:00Z', periodEnd: '2026-05-08T00:00:00Z' })).rejects.toMatchObject({ code: 'period_too_old' });
  });
});

describe('export', () => {
  it('is a zip that verifies: content hash, signed message, signature, key id, items.csv', async () => {
    const { fileName, zip } = await f.service.exportBundle(act(f.p.head), weeklyId);
    expect(fileName).toMatch(/^ocso-exceptions-weekly-2026-09-13-[0-9a-f]{8}\.zip$/);
    const files = readZip(zip);
    expect([...files.keys()].sort()).toEqual(['VERIFY.txt', 'items.csv', 'manifest.json', 'public-key.pem', 'report.json', 'signature.bin', 'signed-message.txt']);
    expect(files.get('VERIFY.txt')!.toString()).toContain('openssl pkeyutl -verify');
    expect(files.get('items.csv')!.toString().split('\r\n')[0]).toBe('check,severity,object_kind,object_id,title,detail,occurred_at,count,team_ids,href');
    const result = verifyExportBundle(zip, [publicKeyOf(f.signer)]);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    const [audit] = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'exception_report.export'), eq(auditEvents.targetId, weeklyId)));
    expect(audit).toBeDefined();
  });

  it('fails when report.json is altered, the signature swapped or the key is not trusted', async () => {
    const { zip } = await f.service.exportBundle(act(f.p.head), weeklyId);
    const files = readZip(zip);
    const rebuild = (changes: Record<string, Buffer>) => writeZip([...files.entries()].map(([name, data]) => ({ name, data: changes[name] ?? data })), new Date());
    const report = JSON.parse(files.get('report.json')!.toString()) as ExceptionReportContent;
    report.sections[0]!.description = 'nothing to see';
    const tampered = verifyExportBundle(rebuild({ 'report.json': Buffer.from(JSON.stringify(report)) }), [publicKeyOf(f.signer)]);
    expect(tampered.ok).toBe(false);
    expect(tampered.checks.find((c) => c.name === 'content hash')?.ok).toBe(false);
    const forged = verifyExportBundle(rebuild({ 'signature.bin': Buffer.alloc(64, 1) }), [publicKeyOf(f.signer)]);
    expect(forged.checks.find((c) => c.name === 'signature')?.ok).toBe(false);
    const stranger = verifyExportBundle(zip, [publicKeyOf(loadSigningKey(generateSigningKeyPem()))]);
    expect(stranger.checks.find((c) => c.name === 'trusted key')?.ok).toBe(false);
    expect(verifyExportBundle(Buffer.from('not a zip')).ok).toBe(false);
    // An edited sign-off note, or a manifest that is not JSON, fails (and never throws).
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    manifest.report.signNote = 'No issues found';
    const renoted = verifyExportBundle(rebuild({ 'manifest.json': Buffer.from(JSON.stringify(manifest)) }), [publicKeyOf(f.signer)]);
    expect(renoted.checks.find((c) => c.name === 'signed message')?.ok).toBe(false);
    expect(verifyExportBundle(rebuild({ 'manifest.json': Buffer.from('{not json') }))).toMatchObject({ ok: false, checks: [{ name: 'manifest', ok: false }] });
  });

  it('only signed reports are exported', async () => {
    const draft = (await f.service.list(f.p.head, { status: 'DRAFT', limit: 10 })).rows[0]!;
    await expect(f.service.exportBundle(act(f.p.head), draft.id)).rejects.toMatchObject({ code: 'report_not_signed' });
  });
});

describe('listing', () => {
  it('pages newest period first', async () => {
    const first = await f.service.list(f.p.head, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const second = await f.service.list(f.p.head, { limit: 10, before: first.next!.before, beforeId: first.next!.beforeId });
    expect(second.rows.map((r) => r.id)).not.toContain(first.rows[0]!.id);
    expect(second.rows.map((r) => r.periodStart).every((p) => p <= first.rows[0]!.periodStart)).toBe(true);
  });
});
