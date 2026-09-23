import { Permission, can, type Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import type { ApprovalRegistry } from '../approvals/registry.js';
import {
  MAX_ITEMS_PER_KIND,
  MAX_ITEMS_PER_KIND_REPORT,
  type ExceptionContext,
  type ExceptionDataSource,
  type ExceptionItem,
  type ExceptionReportContent,
  type ExceptionScopeCount,
  type ExceptionSection,
  type ExceptionSeverity,
} from './contract.js';
import type { Period } from './periods.js';
import { EXCEPTION_KINDS } from './registry.js';

export interface ComputeInput {
  period: Period;
  now: Date;
  mode: ExceptionContext['mode'];
  /** What the content says it is (signed with it). Defaults to LIVE for the live mode, else WEEKLY. */
  kind?: ExceptionReportContent['kind'] | undefined;
  timezone: string;
  approvalAgeWarningHours: number;
  /** Where each data source's retained history starts (retention): sections reading older periods are marked incomplete. */
  dataFrom?: Partial<Record<ExceptionDataSource, Date>> | undefined;
  /** Full error of a failed check, for the server log (the report stores only its class). */
  onCheckError?: ((check: string, err: unknown) => void) | undefined;
}

const SEVERITIES: readonly ExceptionSeverity[] = ['critical', 'high', 'medium', 'low'];

function totalsOf(sections: readonly ExceptionSection[]): ExceptionReportContent['totals'] {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<ExceptionSeverity, number>;
  let items = 0;
  for (const s of sections) {
    items += s.total;
    bySeverity[s.severity] += s.total;
  }
  return {
    items,
    bySeverity,
    failedChecks: sections.filter((s) => s.error !== null).length,
    truncatedChecks: sections.filter((s) => s.truncated).length,
    incompleteChecks: sections.filter((s) => s.coverage && !s.coverage.complete).length,
  };
}

/**
 * A failed check's error as stored in the (immutable, exported) report: a class, never the raw message —
 * driver errors can carry SQL text and parameter values.
 */
export function errorClass(err: unknown): string {
  const codeOf = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);
  const sqlState = [codeOf(err), codeOf((err as { cause?: unknown } | null)?.cause)].find((c) => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c));
  if (typeof sqlState === 'string') return sqlState === '57014' ? 'timeout' : `db_error:${sqlState}`;
  if (err && typeof err === 'object' && 'category' in err && typeof codeOf(err) === 'string') return `domain:${String(codeOf(err))}`;
  return 'check_failed';
}

/** Item counts per distinct audience (teams + readableWith), over every item. */
function scopesOf(items: readonly ExceptionItem[]): ExceptionScopeCount[] {
  const by = new Map<string, ExceptionScopeCount>();
  for (const i of items) {
    const teamIds = [...new Set(i.teamIds)].sort();
    const key = `${teamIds.join(',')}|${i.readableWith ?? ''}`;
    const entry = by.get(key) ?? { teamIds, readableWith: i.readableWith, n: 0 };
    entry.n += 1;
    by.set(key, entry);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/**
 * Runs every exception kind over one consistent snapshot (a REPEATABLE READ,
 * read-only transaction). A kind that fails is recorded with its error class in
 * its section — a report never silently leaves a check out — and each kind runs
 * in its own savepoint so one failure does not abort the others.
 */
export async function computeExceptions(db: Db, registry: ApprovalRegistry, input: ComputeInput): Promise<ExceptionReportContent> {
  const cap = input.mode === 'LIVE' ? MAX_ITEMS_PER_KIND : MAX_ITEMS_PER_KIND_REPORT;
  const sections = await db.transaction(
    async (tx) => {
      const ctx: ExceptionContext = { db: tx, registry, period: input.period, now: input.now, mode: input.mode, approvalAgeWarningHours: input.approvalAgeWarningHours };
      const out: ExceptionSection[] = [];
      for (const kind of EXCEPTION_KINDS) {
        const base = { id: kind.id, label: kind.label, severity: kind.severity, description: kind.description, coverage: coverageOf(kind.sources, input) };
        try {
          const items = await tx.transaction((sp) => kind.compute({ ...ctx, db: sp }));
          out.push({ ...base, items: items.slice(0, cap), total: items.length, truncated: items.length > cap, scopes: scopesOf(items), error: null });
        } catch (err) {
          input.onCheckError?.(kind.id, err);
          out.push({ ...base, items: [], total: 0, truncated: false, scopes: [], error: errorClass(err) });
        }
      }
      return out;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return {
    format: 'ocso-exception-report/2',
    kind: input.kind ?? (input.mode === 'LIVE' ? 'LIVE' : 'WEEKLY'),
    period: { start: input.period.start.toISOString(), end: input.period.end.toISOString(), timezone: input.timezone },
    generatedAt: input.now.toISOString(),
    sections,
    totals: totalsOf(sections),
  };
}

/** The latest start among the check's sources; incomplete when the period begins before it. */
function coverageOf(sources: readonly ExceptionDataSource[] | undefined, input: ComputeInput): ExceptionSection['coverage'] {
  const starts = (sources ?? []).map((s) => input.dataFrom?.[s]).filter((d): d is Date => d instanceof Date);
  if (!starts.length) return null;
  const from = new Date(Math.max(...starts.map((d) => d.getTime())));
  return { dataFrom: from.toISOString(), complete: input.period.start.getTime() >= from.getTime() };
}

/** Signers see (and sign) the whole report; other exceptions.read holders see their teams' items and platform-wide ones. */
export function seesWholeReport(principal: Principal): boolean {
  return can(principal, Permission.EXCEPTIONS_SIGN);
}

/**
 * Whether one reader sees an item: platform-wide items (no team) everyone; team items members of one of its
 * teams; and an item with `readableWith` anyone holding that permission deployment-wide (Tech reads every
 * person's access, whatever their teams).
 */
function visibleTo(principal: Principal, mine: ReadonlySet<string>, audience: { teamIds: readonly string[]; readableWith: string | null }): boolean {
  if (audience.teamIds.length === 0) return true;
  if (audience.teamIds.some((t) => mine.has(t))) return true;
  return audience.readableWith !== null && can(principal, audience.readableWith as Permission);
}

/**
 * The view of a report one reader may see. A scoped view is for reading only:
 * its totals come from the per-audience counts (exact even when the listed
 * items were capped) and it carries no signature (that covers the whole report).
 */
export function scopeContent(content: ExceptionReportContent, principal: Principal): { content: ExceptionReportContent; scoped: boolean } {
  if (seesWholeReport(principal)) return { content, scoped: false };
  const mine = new Set(principal.teamIds);
  const sections = content.sections.map((s) => {
    const items = s.items.filter((i) => visibleTo(principal, mine, i));
    const total = (s.scopes ?? []).reduce((n, sc) => n + (visibleTo(principal, mine, sc) ? sc.n : 0), 0);
    return { ...s, items, total: Math.max(total, items.length), scopes: [] };
  });
  return { content: { ...content, sections, totals: totalsOf(sections) }, scoped: true };
}
