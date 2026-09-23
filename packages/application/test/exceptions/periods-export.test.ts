import { describe, expect, it } from 'vitest';
import { generateSigningKeyPem, loadSigningKey } from '@ocso/audit-store';
import {
  EXCEPTION_KINDS,
  RESTRICTED_TEAM,
  auditStoreGuidance,
  errorClass,
  itemsCsv,
  lastCompleteWeek,
  readZip,
  reportContentHash,
  reportSignatureMessage,
  requiredAttestation,
  scopeContent,
  weekAfter,
  writeZip,
  type ExceptionReportContent,
} from '../../src/index.js';
import { crc32 } from '../../src/exceptions/zip.js';

type Seed = { teamIds: string[]; title: string; readableWith?: string; actorIds?: string[] };
const content = (items: Seed[], shown = items.length): ExceptionReportContent => ({
  format: 'ocso-exception-report/2',
  kind: 'WEEKLY',
  period: { start: '2026-09-14T00:00:00.000Z', end: '2026-09-21T00:00:00.000Z', timezone: 'UTC' },
  generatedAt: '2026-09-21T01:00:00.000Z',
  sections: [
    {
      id: 'live_without_approval',
      label: 'Live without approval',
      severity: 'critical',
      description: 'd',
      items: items.slice(0, shown).map((i, n) => ({
        objectKind: 'agent',
        objectId: `id-${n}`,
        title: i.title,
        detail: 'x',
        occurredAt: '2026-09-15T00:00:00.000Z',
        href: null,
        teamIds: i.teamIds,
        readableWith: i.readableWith ?? null,
        actorIds: i.actorIds ?? [],
        subjectIds: [],
        count: 1,
      })),
      total: items.length,
      truncated: shown < items.length,
      scopes: items.map((i) => ({ teamIds: i.teamIds, readableWith: i.readableWith ?? null, n: 1 })),
      coverage: null,
      error: null,
    },
  ],
  totals: { items: items.length, bySeverity: { critical: items.length, high: 0, medium: 0, low: 0 }, failedChecks: 0, truncatedChecks: shown < items.length ? 1 : 0, incompleteChecks: 0 },
});

describe('report periods', () => {
  it('a week is Monday 00:00 to Monday 00:00 in the deployment time zone', () => {
    expect(lastCompleteWeek(new Date('2026-09-23T10:00:00Z'), 'UTC')).toEqual({ start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') });
    expect(lastCompleteWeek(new Date('2026-09-23T10:00:00Z'), 'Asia/Kolkata')).toEqual({ start: new Date('2026-09-13T18:30:00Z'), end: new Date('2026-09-20T18:30:00Z') });
    // Monday 00:30 local is already the new week: the report is the week that just ended.
    expect(lastCompleteWeek(new Date('2026-09-20T19:00:00Z'), 'Asia/Kolkata').end).toEqual(new Date('2026-09-20T18:30:00Z'));
    // Sunday 23:59 local is still last week's last day.
    expect(lastCompleteWeek(new Date('2026-09-20T18:29:00Z'), 'Asia/Kolkata').end).toEqual(new Date('2026-09-13T18:30:00Z'));
  });

  it('a week across a DST change has 167 or 169 hours; an unknown zone falls back to UTC', () => {
    const spring = lastCompleteWeek(new Date('2026-04-01T12:00:00Z'), 'Europe/London');
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(167);
    const autumn = lastCompleteWeek(new Date('2026-10-28T12:00:00Z'), 'Europe/London');
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(169);
    expect(lastCompleteWeek(new Date('2026-09-23T10:00:00Z'), 'Mars/Olympus')).toEqual(lastCompleteWeek(new Date('2026-09-23T10:00:00Z'), 'UTC'));
  });

  it('weekly periods chain: the next starts where the last ended, a zone change makes one bridging period', () => {
    const week = lastCompleteWeek(new Date('2026-09-23T10:00:00Z'), 'Asia/Kolkata');
    expect(weekAfter(week.end, 'Asia/Kolkata')).toEqual({ start: week.end, end: new Date('2026-09-27T18:30:00Z') });
    // A report frozen in UTC, then the deployment moves to Asia/Kolkata: 6 d 18.5 h, no gap, no overlap.
    const bridge = weekAfter(new Date('2026-09-14T00:00:00Z'), 'Asia/Kolkata');
    expect(bridge).toEqual({ start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-20T18:30:00Z') });
    // Dubai → New York: the Monday 04:00 UTC boundary is less than a day away, so the bridge runs to the next one.
    const dubaiMonday = new Date('2026-09-20T20:00:00Z');
    const ny = weekAfter(dubaiMonday, 'America/New_York');
    expect(ny.start).toEqual(dubaiMonday);
    expect(ny.end).toEqual(new Date('2026-09-28T04:00:00Z'));
    expect((ny.end.getTime() - ny.start.getTime()) / 3_600_000).toBe(176);
  });
});

describe('signing text and hashing', () => {
  it('the signed message is the spec’s six lines, then the attestation and the note’s hash', () => {
    const base = { id: 'r1', period: { start: new Date('2026-09-14T00:00:00Z'), end: new Date('2026-09-21T00:00:00Z') }, contentHash: 'abc', signedBy: 'u1', signedAt: new Date('2026-09-22T09:00:00Z') };
    expect(reportSignatureMessage({ ...base, attestation: [], signNote: null })).toBe(
      'ocso-exception-report\nr1\n2026-09-14T00:00:00.000Z/2026-09-21T00:00:00.000Z\nabc\nu1\n2026-09-22T09:00:00.000Z\nattestation:none\nnote-sha256:none',
    );
    const withNote = reportSignatureMessage({ ...base, attestation: ['truncated', 'self_attested'], signNote: 'ok' });
    expect(withNote.split('\n').slice(6)).toEqual(['attestation:self_attested,truncated', 'note-sha256:2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df']);
  });

  it('a failed check stores its class, never the driver message', () => {
    expect(errorClass(Object.assign(new Error('Failed query: select secret from x params: 42'), { cause: { code: '42P01' } }))).toBe('db_error:42P01');
    expect(errorClass(Object.assign(new Error('canceling statement'), { code: '57014' }))).toBe('timeout');
    expect(errorClass(new Error('descriptor exploded'))).toBe('check_failed');
  });

  it('attestation: self-attested when the signer is named in a critical item, plus failed/truncated/incomplete flags', () => {
    const c = content([{ teamIds: [], title: 'x', actorIds: ['signer'] }, { teamIds: [], title: 'y' }], 1);
    expect(requiredAttestation(c, 'signer', false)).toEqual(['self_attested', 'truncated']);
    expect(requiredAttestation(c, 'other', false)).toEqual(['truncated']);
    expect(requiredAttestation(c, 'other', true)).toEqual(['self_attested', 'truncated']);
    const failed = { ...c, totals: { ...c.totals, failedChecks: 1 }, sections: [{ ...c.sections[0]!, truncated: false, coverage: { dataFrom: '2026-09-15T00:00:00.000Z', complete: false } }] };
    expect(requiredAttestation(failed, 'other', false)).toEqual(['failed_checks', 'incomplete_data']);
  });

  it('the content hash ignores key order but not values', () => {
    const a = content([{ teamIds: [], title: 'x' }]);
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as ExceptionReportContent;
    expect(reportContentHash(reordered)).toBe(reportContentHash(a));
    expect(reportContentHash(content([{ teamIds: [], title: 'y' }]))).not.toBe(reportContentHash(a));
  });

  it('signatures use Ed25519 keys only', () => {
    expect(loadSigningKey(generateSigningKeyPem()).algorithm).toBe('Ed25519');
  });
});

describe('scoping a report', () => {
  it('keeps platform-wide items and the reader’s teams, recomputing totals', () => {
    const c = content([
      { teamIds: [], title: 'platform' },
      { teamIds: ['cards'], title: 'cards' },
      { teamIds: ['loans'], title: 'loans' },
    ]);
    const reader = { userId: 'u', role: 'TECH', displayName: 'T', teamIds: ['cards'], via: 'UI' } as const;
    const { content: scoped, scoped: isScoped } = scopeContent(c, reader);
    expect(isScoped).toBe(true);
    expect(scoped.sections[0]!.items.map((i) => i.title)).toEqual(['platform', 'cards']);
    expect(scoped.totals.items).toBe(2);
    expect(scopeContent(c, { ...reader, role: 'HEAD' }).content.totals.items).toBe(3);
  });

  it('scoped totals are exact when the section was truncated, and restricted items stay with signers', () => {
    const c = content(
      [
        { teamIds: ['loans'], title: 'loans 1' },
        { teamIds: ['cards'], title: 'cards (not listed)' },
        { teamIds: [RESTRICTED_TEAM], title: 'teams unknown' },
      ],
      1,
    );
    const reader = { userId: 'u', role: 'TECH', displayName: 'T', teamIds: ['cards'], via: 'UI' } as const;
    const scoped = scopeContent(c, reader).content.sections[0]!;
    expect(scoped.items).toEqual([]);
    expect(scoped.total).toBe(1);
    expect(scoped.scopes).toEqual([]);
  });

  it('an item readable deployment-wide is shown to a holder of that permission outside its teams', () => {
    const c = content([{ teamIds: ['loans'], title: 'access of a loans agent', readableWith: 'users.read' }]);
    const tech = { userId: 'u', role: 'TECH', displayName: 'T', teamIds: [], via: 'UI' } as const;
    expect(scopeContent(c, tech).content.sections[0]!.items.map((i) => i.title)).toEqual(['access of a loans agent']);
    const lead = { userId: 'u', role: 'LEAD', displayName: 'L', teamIds: ['cards'], via: 'UI', permissions: new Set(['exceptions.read']) } as const;
    expect(scopeContent(c, lead as never).content.sections[0]!.items).toEqual([]);
  });
});

describe('export files', () => {
  it('items.csv escapes quotes, commas, newlines and neutralises spreadsheet formulas', () => {
    const csv = itemsCsv(content([{ teamIds: ['a', 'b'], title: '=HYPERLINK("x"), "quoted"\nline' }]));
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain(`"'=HYPERLINK(""x""), ""quoted""\nline"`);
    expect(row).toContain(',a b,');
  });

  it('a stored zip round-trips and detects damage', () => {
    const zip = writeZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b/c.json', data: Buffer.from('{}') }], new Date('2026-09-22T09:00:00Z'));
    expect([...readZip(zip).entries()].map(([k, v]) => [k, v.toString()])).toEqual([['a.txt', 'hello'], ['b/c.json', '{}']]);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const damaged = Buffer.from(zip);
    damaged[31 + 5] = (damaged[31 + 5] ?? 0) ^ 0xff;
    expect(() => readZip(damaged)).toThrow(/damaged/);
  });
});

describe('the kind registry', () => {
  it('has the ten checks of the spec plus drift, migration-only and report hygiene; unique ids, each described', () => {
    expect(EXCEPTION_KINDS.map((k) => k.id).sort()).toEqual(
      [
        'approvals_aged',
        'audit_chain',
        'audit_shipping',
        'bootstrap_approvals',
        'changed_outside_approval',
        'delivery_failures',
        'installed_only',
        'live_without_approval',
        'permission_bypass',
        'report_hygiene',
        'resubmitted_unchanged',
        'routing_fallback',
        'templates_rejected',
      ].sort(),
    );
    for (const k of EXCEPTION_KINDS) expect(k.description.length).toBeGreaterThan(20);
  });
});

const ROW = { kind: 'row', label: 'PostgreSQL' } as const;

describe('audit store guidance (ClickHouse)', () => {
  it('stays on postgres while small, suggests considering it on size or rate, recommends it past the thresholds', () => {
    expect(auditStoreGuidance({ driver: 'postgres', sizing: ROW, rows: 1_000_000, bytes: 2 * 1024 ** 3, rowsPerDay: 10_000, bytesPerDay: 1e7 }).level).toBe('ok');
    expect(auditStoreGuidance({ driver: 'postgres', sizing: ROW, rows: null, bytes: null, rowsPerDay: null, bytesPerDay: null }).level).toBe('ok');
    expect(auditStoreGuidance({ driver: 'postgres', sizing: ROW, rows: 60_000_000, bytes: 10 * 1024 ** 3, rowsPerDay: 10_000, bytesPerDay: 1e7 }).level).toBe('consider');
    // Small today but on course to pass the recommend line within the horizon.
    const projected = auditStoreGuidance({ driver: 'postgres', sizing: ROW, rows: 10_000_000, bytes: 1024 ** 3, rowsPerDay: 1_500_000, bytesPerDay: 1e7 });
    expect(projected.level).toBe('consider');
    expect(projected.reasons.join(' ')).toMatch(/within 180 days/);
    expect(auditStoreGuidance({ driver: 'postgres', sizing: ROW, rows: 300_000_000, bytes: 10 * 1024 ** 3, rowsPerDay: 10_000, bytesPerDay: 1e7 }).level).toBe('recommend');
    expect(auditStoreGuidance({ driver: 'x', sizing: { kind: 'columnar', label: 'Columnar' }, rows: 300_000_000, bytes: null, rowsPerDay: null, bytesPerDay: null }).level).toBe('columnar');
    // A store that declares no sizing reads as a row store.
    expect(auditStoreGuidance({ driver: 'x', sizing: null, rows: 300_000_000, bytes: null, rowsPerDay: null, bytesPerDay: null }).level).toBe('recommend');
  });
});
