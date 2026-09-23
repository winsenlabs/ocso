import { sql } from 'drizzle-orm';
import type { ExceptionKind } from '../contract.js';
import { age, at, isoOf, item, rows } from './support.js';

/**
 * The report's own control (PM/research/11 §7, ADR-033): a weekly report that
 * was not generated, one left unsigned, and drafts whose checks failed. Shown
 * in the live view and carried into the next report, so a lapse never goes quiet.
 */

/** A weekly report is expected within a day of its week ending, and signed within a week. */
export const WEEKLY_OVERDUE_HOURS = 30;
export const UNSIGNED_AFTER_DAYS = 7;

export const reportHygiene: ExceptionKind = {
  id: 'report_hygiene',
  label: 'Exception reports overdue',
  severity: 'medium',
  description: `Weekly reports not generated within ${WEEKLY_OVERDUE_HOURS} h of the week ending, weekly reports unsigned ${UNSIGNED_AFTER_DAYS} days after it, and unsigned reports whose checks failed. As of generation.`,
  async compute(ctx) {
    const [state] = await rows<{ setup: Date | null; last_end: Date | null }>(
      ctx.db,
      sql`SELECT (SELECT setup_completed_at FROM deployment_settings WHERE id = 1) AS setup,
                 (SELECT max(period_end) FROM exception_reports WHERE kind = 'WEEKLY' AND status <> 'SUPERSEDED') AS last_end`,
    );
    const out = [];
    const overdue = new Date(ctx.now.getTime() - (7 * 24 + WEEKLY_OVERDUE_HOURS) * 3_600_000);
    const since = state?.last_end ? new Date(state.last_end) : state?.setup ? new Date(state.setup) : null;
    if (since && since < overdue) {
      out.push(
        item({
          objectKind: 'exception_report',
          objectId: null,
          title: state?.last_end ? `No weekly report for the ${age(ctx.now.getTime() - since.getTime())} since ${isoOf(since, ctx.now).slice(0, 10)}` : 'No weekly report has been generated yet',
          detail: 'The worker’s leader generates each week’s report after the week ends (and fills any missed weeks). Check that a worker is running.',
          occurredAt: ctx.now.toISOString(),
          href: '/exceptions?view=reports',
        }),
      );
    }
    const drafts = await rows<{ id: string; kind: string; period_start: Date; period_end: Date; failed: number }>(
      ctx.db,
      sql`SELECT id, kind, period_start, period_end, coalesce((content->'totals'->>'failedChecks')::int, 0) AS failed
            FROM exception_reports
           WHERE status = 'DRAFT'
             AND ((kind = 'WEEKLY' AND period_end < ${at(new Date(ctx.now.getTime() - UNSIGNED_AFTER_DAYS * 86_400_000))})
                  OR coalesce((content->'totals'->>'failedChecks')::int, 0) > 0)
           ORDER BY period_start, id`,
    );
    for (const d of drafts) {
      const week = `${isoOf(d.period_start, ctx.now).slice(0, 10)} – ${isoOf(d.period_end, ctx.now).slice(0, 10)}`;
      out.push(
        item({
          objectKind: 'exception_report',
          objectId: d.id,
          title: d.failed > 0 ? `The ${d.kind.toLowerCase()} report for ${week} has ${d.failed} failed check(s)` : `The weekly report for ${week} is not signed`,
          detail: d.failed > 0 ? 'Regenerate it once the cause is fixed, or sign it acknowledging the failed checks.' : `Unsigned ${age(ctx.now.getTime() - new Date(d.period_end).getTime())} after the week ended.`,
          occurredAt: isoOf(d.period_end, ctx.now),
          href: `/exceptions/reports/${d.id}`,
        }),
      );
    }
    return out;
  },
};
