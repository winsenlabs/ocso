import { and, desc, eq, ne } from 'drizzle-orm';
import { exceptionReports, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import type { ApprovalRegistry } from '../approvals/registry.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { effectiveRetention } from '../retention/policy.js';
import type { DeploymentSettings } from '../settings/settings.js';
import type { ActorContext } from '../shared/context.js';
import { computeExceptions } from './compute.js';
import type { ExceptionDataSource, ExceptionReportContent } from './contract.js';
import { lastCompleteWeek, safeZone, weekAfter, type Period } from './periods.js';
import { reportContentHash } from './signing.js';

/**
 * Freezing reports (PM/research/11 §7, ADR-033): computing a period's content,
 * inserting it with its audit row and `exception_report.ready`, and the weekly
 * chain — each weekly period starts where the last one ended, missed weeks are
 * filled in order, and nothing is generated before setup is complete.
 */

type Row = typeof exceptionReports.$inferSelect;
const DAY = 86_400_000;

/** Weeks filled per run: a long outage is caught up over a few hourly runs, oldest first. */
export const MAX_WEEKS_PER_RUN = 8;

export interface GenerationDeps {
  db: Db;
  registry: ApprovalRegistry;
  now: Date;
  onCheckError?: ((check: string, err: unknown) => void) | undefined;
}

/** Where each source's retained history starts today (the deployment's retention; audit: the local window). */
export function dataFromOf(settings: DeploymentSettings, now: Date): Record<ExceptionDataSource, Date> {
  const days = effectiveRetention(settings.retention as Record<string, number>);
  return {
    audit: new Date(now.getTime() - Math.max(90, settings.auditLocalWindowDays) * DAY),
    conversation: new Date(now.getTime() - days.conversationContent * DAY),
    operational: new Date(now.getTime() - days.operational * DAY),
  };
}

export function computeReport(deps: GenerationDeps, settings: DeploymentSettings, period: Period, kind: Row['kind'], timezone: string): Promise<ExceptionReportContent> {
  return computeExceptions(deps.db, deps.registry, {
    period,
    now: deps.now,
    mode: 'REPORT',
    kind,
    timezone,
    approvalAgeWarningHours: settings.approvalAgeWarningHours,
    dataFrom: dataFromOf(settings, deps.now),
    onCheckError: deps.onCheckError,
  });
}

/** Hash exactly what jsonb gives back (plain JSON), so verification after a read matches. */
export function frozen(raw: ExceptionReportContent): { content: ExceptionReportContent; contentHash: string } {
  const content = JSON.parse(JSON.stringify(raw)) as ExceptionReportContent;
  return { content, contentHash: reportContentHash(content) };
}

/**
 * Inserts a report in the caller's transaction, audited and announced. Returns null when another writer
 * already froze an overlapping weekly period (the exclusion constraint; ON CONFLICT DO NOTHING).
 */
export async function insertReport(
  tx: DbOrTx,
  actor: ActorContext,
  r: { id?: string | undefined; kind: Row['kind']; period: Period; raw: ExceptionReportContent; now: Date; generatedBy: string | null },
): Promise<string | null> {
  const { content, contentHash } = frozen(r.raw);
  const [row] = await tx
    .insert(exceptionReports)
    .values({ id: r.id ?? uuidv7(), kind: r.kind, periodStart: r.period.start, periodEnd: r.period.end, content: content as unknown as Record<string, unknown>, contentHash, generatedAt: r.now, generatedBy: r.generatedBy })
    .onConflictDoNothing()
    .returning({ id: exceptionReports.id });
  if (!row) return null;
  const span = `${r.period.start.toISOString().slice(0, 10)} – ${r.period.end.toISOString().slice(0, 10)}`;
  await recordAudit(tx, actor, {
    action: 'exception_report.generate',
    targetType: 'exception_report',
    targetId: row.id,
    summary: `Generated the ${r.kind.toLowerCase()} exception report for ${span}: ${content.totals.items} item(s)`,
    after: { contentHash, totals: content.totals },
  });
  // No item count: the event reaches scoped readers, and the whole report's count is not theirs to see.
  await emitEvent(tx, actor, 'exception_report.ready', { reportId: row.id, kind: r.kind, periodStart: r.period.start.toISOString(), periodEnd: r.period.end.toISOString() });
  return row.id;
}

export async function latestWeekly(db: DbOrTx): Promise<{ id: string; periodStart: Date; periodEnd: Date } | null> {
  const [r] = await db
    .select({ id: exceptionReports.id, periodStart: exceptionReports.periodStart, periodEnd: exceptionReports.periodEnd })
    .from(exceptionReports)
    .where(and(eq(exceptionReports.kind, 'WEEKLY'), ne(exceptionReports.status, 'SUPERSEDED')))
    .orderBy(desc(exceptionReports.periodEnd))
    .limit(1);
  return r ?? null;
}

export interface WeeklyOutcome {
  /** The latest weekly report after this run (created now or before); null before setup or before the first week ends. */
  id: string | null;
  created: boolean;
  period: Period | null;
  /** Reports created by this run, oldest first. */
  generated: string[];
  /** Why nothing was generated, when nothing was. */
  skipped?: 'setup_incomplete' | undefined;
}

/**
 * Freezes every complete weekly period not yet frozen. The first report covers the last complete Monday-to-Monday
 * week (deployment time zone); each later one starts at the previous one's end (periods.weekAfter), so a worker
 * outage is back-filled and a time-zone change leaves neither gap nor overlap.
 */
export async function generateWeeklyReports(deps: GenerationDeps, settings: DeploymentSettings, actor: ActorContext): Promise<WeeklyOutcome> {
  if (!settings.setupCompletedAt) return { id: null, created: false, period: null, generated: [], skipped: 'setup_incomplete' };
  const zone = safeZone(settings.timezone);
  const last = await latestWeekly(deps.db);
  let next: Period = last ? weekAfter(last.periodEnd, zone) : lastCompleteWeek(deps.now, zone);
  const generated: string[] = [];
  let latest: { id: string; period: Period } | null = null;
  while (next.end.getTime() <= deps.now.getTime() && generated.length < MAX_WEEKS_PER_RUN) {
    const raw = await computeReport(deps, settings, next, 'WEEKLY', zone);
    const period = next;
    const id = await deps.db.transaction((tx) => insertReport(tx, actor, { kind: 'WEEKLY', period, raw, now: deps.now, generatedBy: null }));
    if (!id) break; // another leader froze it and continues the chain
    generated.push(id);
    latest = { id, period };
    next = weekAfter(next.end, zone);
  }
  if (latest) return { id: latest.id, created: true, period: latest.period, generated };
  const current = await latestWeekly(deps.db);
  return { id: current?.id ?? null, created: false, period: current ? { start: current.periodStart, end: current.periodEnd } : null, generated };
}
