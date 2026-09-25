/**
 * When to move the audit store to ClickHouse (PM/research/11 §6.5, §7). The
 * postgres driver is right for most deployments: it is simple to run and back
 * up, and range partitions keep purges cheap. ClickHouse earns its operational
 * cost when the audit trail is large or grows fast — long retention (a bank's
 * 7 years) times a high event rate. The thresholds are deliberately round and
 * conservative; they are guidance for an operator, never an automatic switch.
 */
export const AUDIT_STORE_GUIDANCE = {
  /** Audit records held in the store. */
  rows: { consider: 50_000_000, recommend: 250_000_000 },
  /** Audit store size on disk. */
  bytes: { consider: 50 * 1024 ** 3, recommend: 250 * 1024 ** 3 },
  /** Audit events written per day (30-day average). */
  eventsPerDay: { consider: 500_000, recommend: 2_000_000 },
  /** The projection horizon: where rows and size will be after this many days at the current rate. */
  horizonDays: 180,
} as const;

export type GuidanceLevel = 'ok' | 'consider' | 'recommend' | 'columnar';

export interface AuditStoreGuidance {
  level: GuidanceLevel;
  driver: string;
  reasons: string[];
  /** What the numbers were judged on. */
  basis: { rows: number | null; bytes: number | null; eventsPerDay: number | null; projectedRows: number | null; projectedBytes: number | null };
  thresholds: typeof AUDIT_STORE_GUIDANCE;
}

const GIB = 1024 ** 3;
const fmtRows = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const fmtBytes = (n: number) => `${(n / GIB).toFixed(1)} GiB`;

export interface GuidanceInput {
  /** AUDIT_DRIVER, for display only (core never compares it). */
  driver: string;
  /** The store's own sizing profile (AuditStore.sizing); null reads as a row store. */
  sizing: { kind: 'row' | 'columnar'; label: string } | null;
  rows: number | null;
  bytes: number | null;
  /** Rows added per day (30-day average), null without enough samples. */
  rowsPerDay: number | null;
  bytesPerDay: number | null;
}

export function auditStoreGuidance(input: GuidanceInput): AuditStoreGuidance {
  const g = AUDIT_STORE_GUIDANCE;
  const projectedRows = input.rows !== null && input.rowsPerDay !== null ? input.rows + input.rowsPerDay * g.horizonDays : null;
  const projectedBytes = input.bytes !== null && input.bytesPerDay !== null ? input.bytes + input.bytesPerDay * g.horizonDays : null;
  const basis = { rows: input.rows, bytes: input.bytes, eventsPerDay: input.rowsPerDay, projectedRows, projectedBytes };
  if (input.sizing?.kind === 'columnar') {
    return { level: 'columnar', driver: input.driver, reasons: [`The audit store already runs on a columnar engine (${input.sizing.label}).`], basis, thresholds: g };
  }
  const recommend: string[] = [];
  const consider: string[] = [];
  const judge = (value: number | null, t: { consider: number; recommend: number }, what: (v: number) => string) => {
    if (value === null) return;
    if (value >= t.recommend) recommend.push(what(value));
    else if (value >= t.consider) consider.push(what(value));
  };
  judge(input.rows, g.rows, (v) => `The audit store holds ${fmtRows(v)} records (threshold ${fmtRows(g.rows.consider)} / ${fmtRows(g.rows.recommend)}).`);
  judge(input.bytes, g.bytes, (v) => `The audit store uses ${fmtBytes(v)} (threshold ${fmtBytes(g.bytes.consider)} / ${fmtBytes(g.bytes.recommend)}).`);
  judge(input.rowsPerDay, g.eventsPerDay, (v) => `About ${fmtRows(v)} audit events are written a day (threshold ${fmtRows(g.eventsPerDay.consider)} / ${fmtRows(g.eventsPerDay.recommend)}).`);
  // A projection past the recommend line within the horizon is a reason to plan, not yet to move.
  if (projectedRows !== null && projectedRows >= g.rows.recommend && !recommend.length) {
    consider.push(`At the current rate the store reaches ${fmtRows(projectedRows)} records within ${g.horizonDays} days.`);
  }
  if (projectedBytes !== null && projectedBytes >= g.bytes.recommend && !recommend.length) {
    consider.push(`At the current rate the store reaches ${fmtBytes(projectedBytes)} within ${g.horizonDays} days.`);
  }
  const move = 'Plan a move to the columnar audit store driver (ClickHouse, built in; docs/archive/specs/11 §10).';
  if (recommend.length) return { level: 'recommend', driver: input.driver, reasons: [...recommend, ...consider, move], basis, thresholds: g };
  if (consider.length) return { level: 'consider', driver: input.driver, reasons: consider, basis, thresholds: g };
  return {
    level: 'ok',
    driver: input.driver,
    reasons: [input.rows === null ? 'No audit store sample yet; the storage-sample task records one a day.' : `The ${input.sizing?.label ?? input.driver} audit store is well within its comfortable range.`],
    basis,
    thresholds: g,
  };
}
