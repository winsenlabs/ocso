import { sql } from 'drizzle-orm';
import { AUDIT_LAG_WARNING_SECONDS } from '../../audit/status.js';
import type { ExceptionItem, ExceptionKind } from '../contract.js';
import { age, at, isoOf, item, plural, rows } from './support.js';

/**
 * The audit trail's own health (ADR-032): shipping to the audit store and the
 * hash chain. Incidents that overlapped the period are listed whether or not
 * they are resolved now; the current shipping lag is a state as of generation.
 */

interface IncidentRow extends Record<string, unknown> {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  first_seen: Date;
  last_seen: Date;
  count: number;
  resolved_at: Date | null;
}

const WORDS: Record<string, string> = {
  SHIP_FAILED: 'Shipping audit events to the audit store failed',
  STORE_DOWN: 'The audit store was unreachable',
  RECONCILE_MISSING: 'The audit store was missing shipped events (they were re-sent)',
  EXPORT_FAILED: 'The signed audit export failed or was blocked',
  CHAIN_BROKEN: 'The audit hash chain did not verify',
  SIGNING_KEY_CHANGED: 'Audit checkpoints were signed by a key this deployment does not trust',
};

function incidentItem(r: IncidentRow, now: Date): ExceptionItem {
  const range = typeof r.detail['firstBrokenAt'] === 'number' ? ` Entries #${String(r.detail['firstBrokenAt'])}–${String(r.detail['lastBrokenAt'])} did not verify.` : '';
  const ack = r.detail['acknowledged'] as { note?: string } | undefined;
  return item({
    objectKind: 'audit_incident',
    objectId: r.id,
    title: `${WORDS[r.kind] ?? r.kind} (${plural(r.count, 'time')})`,
    detail: `From ${isoOf(r.first_seen, now)} to ${isoOf(r.last_seen, now)}; ${r.resolved_at ? `resolved ${isoOf(r.resolved_at, now)}` : 'still open'}.${range}${ack?.note ? ` Acknowledged: ${ack.note}` : ''}`,
    occurredAt: isoOf(r.last_seen, now),
    href: '/system#audit-store',
    count: r.count,
  });
}

function incidents(kinds: readonly string[]) {
  return (ctx: { db: Parameters<typeof rows>[0]; period: { start: Date; end: Date } }) =>
    rows<IncidentRow>(
      ctx.db,
      sql`SELECT id, kind, detail, first_seen, last_seen, count, resolved_at FROM audit_incidents
           WHERE kind IN (${sql.join(
             kinds.map((k) => sql`${k}`),
             sql`, `,
           )})
             AND first_seen < ${at(ctx.period.end)} AND (resolved_at IS NULL OR resolved_at >= ${at(ctx.period.start)})
           ORDER BY last_seen DESC, id`,
    );
}

export const auditShipping: ExceptionKind = {
  id: 'audit_shipping',
  label: 'Audit shipping',
  severity: 'high',
  description: `Audit store incidents (shipping failed, store down, events missing, exports failed) that overlapped the period, and the shipping lag as of generation when it exceeds ${AUDIT_LAG_WARNING_SECONDS} s.`,
  async compute(ctx) {
    const found = await incidents(['SHIP_FAILED', 'STORE_DOWN', 'RECONCILE_MISSING', 'EXPORT_FAILED'])(ctx);
    const [lag] = await rows<{ waiting: number; oldest: Date | null }>(
      ctx.db,
      sql`SELECT count(*)::int AS waiting, min(occurred_at) AS oldest FROM audit_events WHERE shipped_at IS NULL AND occurred_at <= ${at(ctx.now)}`,
    );
    const out = found.map((r) => incidentItem(r, ctx.now));
    const oldest = lag?.oldest ? new Date(lag.oldest) : null;
    if (oldest && ctx.now.getTime() - oldest.getTime() > AUDIT_LAG_WARNING_SECONDS * 1000) {
      out.unshift(
        item({
          objectKind: 'audit_store',
          objectId: null,
          title: `${plural(lag?.waiting ?? 0, 'audit event')} not yet in the audit store; oldest waiting ${age(ctx.now.getTime() - oldest.getTime())}`,
          detail: 'The events are safe in the main database (the outbox) and ship when the store answers; until then the store copy lags.',
          occurredAt: oldest.toISOString(),
          href: '/system#audit-store',
          count: lag?.waiting ?? 0,
        }),
      );
    }
    return out;
  },
};

export const auditChain: ExceptionKind = {
  id: 'audit_chain',
  label: 'Audit chain integrity',
  severity: 'critical',
  description: 'Hash-chain breaks and untrusted checkpoint keys that overlapped the period, and full-chain verifications in the period that found problems.',
  async compute(ctx) {
    const found = await incidents(['CHAIN_BROKEN', 'SIGNING_KEY_CHANGED'])(ctx);
    const failed = await rows<{ id: string; finished_at: Date; entries: number; problems: unknown[] }>(
      ctx.db,
      sql`SELECT id, finished_at, entries, problems FROM audit_verifications
           WHERE finished_at >= ${at(ctx.period.start)} AND finished_at < ${at(ctx.period.end)} AND NOT ok
           ORDER BY finished_at DESC, id`,
    );
    return [
      ...found.map((r) => incidentItem(r, ctx.now)),
      ...failed.map((v) =>
        item({
          objectKind: 'audit_verification',
          objectId: v.id,
          title: `A full audit-chain verification found ${plural(Array.isArray(v.problems) ? v.problems.length : 0, 'problem')}`,
          detail: `${plural(v.entries, 'entry', 'entries')} checked. ${Array.isArray(v.problems) && v.problems[0] ? `First: ${JSON.stringify(v.problems[0]).slice(0, 300)}` : ''}`.trim(),
          occurredAt: isoOf(v.finished_at, ctx.now),
          href: '/system#audit-store',
        }),
      ),
    ];
  },
};
