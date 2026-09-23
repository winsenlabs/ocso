import { sql } from 'drizzle-orm';
import type { Db } from '@ocso/db';
import { modelWindowStats } from '../telemetry/tiles.js';
import { uptime } from '../telemetry/uptime.js';
import { myCsat, myFirstResponseMedian, myResolvedCount, type ExecHome } from './home-exec.js';
import type { LeadHome, LeadPrevious } from './home-lead.js';
import { at, int } from './values.js';

/**
 * Trend tiles (HOME decision 4): value, the same figure over the previous
 * period, and which direction is good. `%` values are ratios 0–1. `period`
 * says what is compared: 'today' = today so far vs yesterday (to the same time
 * of day for counts), '7d' = the last 7 days vs the 7 before, 'now' = a live
 * figure with no history (previous is null).
 */
export type TileUnit = '%' | 'ms' | 's' | 'count' | 'score';
export type TilePeriod = 'today' | '7d' | 'now';

export interface HomeTile {
  key: string;
  label: string;
  value: number | null;
  unit?: TileUnit;
  previous: number | null;
  betterWhen: 'up' | 'down' | 'none';
  period: TilePeriod;
  href?: string;
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/** Service figures for the previous period (yesterday, the 7 days before), read alongside the exec surface. */
export interface ServicePrevious {
  resolvedYesterday: number;
  frtToday: number | null;
  frtYesterday: number | null;
  csatPrevious: number | null;
}

export async function servicePrevious(db: Db, me: string, now: Date, dayStart: Date, yesterdayStart: Date): Promise<ServicePrevious> {
  const weekAgo = new Date(now.getTime() - WEEK);
  const [resolvedYesterday, frtToday, frtYesterday, csatPrev] = await Promise.all([
    // Yesterday up to the same time of day: a partial today is compared with a like-for-like yesterday.
    myResolvedCount(db, me, yesterdayStart, new Date(Math.min(now.getTime() - DAY, dayStart.getTime()))),
    myFirstResponseMedian(db, me, dayStart, now),
    myFirstResponseMedian(db, me, yesterdayStart, dayStart),
    myCsat(db, me, new Date(weekAgo.getTime() - WEEK), weekAgo),
  ]);
  return { resolvedYesterday, frtToday, frtYesterday, csatPrevious: csatPrev.average };
}

/** Service: my throughput and quality, and the live state of my queues. */
export function serviceTiles(exec: ExecHome, p: ServicePrevious): HomeTile[] {
  const t = exec.tiles;
  return [
    { key: 'resolved_today', label: 'Resolved today', value: t.resolvedToday, unit: 'count', previous: p.resolvedYesterday, betterWhen: 'up', period: 'today', href: '/conversations?view=resolved' },
    { key: 'first_response', label: 'My first response (median)', value: p.frtToday, unit: 's', previous: p.frtYesterday, betterWhen: 'down', period: 'today', href: '/conversations?view=mine' },
    { key: 'csat', label: 'My CSAT', value: t.myCsat7d.average, unit: 'score', previous: p.csatPrevious, betterWhen: 'up', period: '7d', href: '/conversations?view=resolved' },
    { key: 'waiting', label: 'Waiting in my queues', value: t.waitingForHuman, unit: 'count', previous: null, betterWhen: 'down', period: 'now', href: '/conversations?view=waiting' },
    { key: 'sla_breached', label: 'Past SLA', value: t.slaBreached, unit: 'count', previous: null, betterWhen: 'down', period: 'now', href: '/conversations?view=waiting' },
  ];
}

/** Head / Lead: their teams' agents over 7 days vs the 7 before (same KPIs as the analytics page). */
export function leadTiles(lead: LeadHome, previous: LeadPrevious): HomeTile[] {
  const t = lead.tiles;
  return [
    { key: 'conversations', label: 'Conversations', value: t.conversations, unit: 'count', previous: previous.conversations, betterWhen: 'none', period: '7d', href: '/analytics' },
    { key: 'containment', label: 'Contained by AI', value: t.containmentRate, unit: '%', previous: previous.containmentRate, betterWhen: 'up', period: '7d', href: '/analytics' },
    { key: 'escalation', label: 'Escalation rate', value: t.escalationRate, unit: '%', previous: previous.escalationRate, betterWhen: 'down', period: '7d', href: '/escalation-reasons' },
    { key: 'sla_breaches', label: 'SLA breaches', value: t.slaBreaches, unit: 'count', previous: previous.slaBreaches, betterWhen: 'down', period: '7d', href: '/sla' },
    { key: 'csat', label: 'CSAT', value: t.csat.average, unit: 'score', previous: previous.csat, betterWhen: 'up', period: '7d', href: '/analytics' },
  ];
}

/** Tech: platform health over 7 days vs the 7 before. Counts and timings only. (Home adds the live open-incidents tile.) */
export async function techTiles(db: Db, now: Date): Promise<HomeTile[]> {
  const weekAgo = new Date(now.getTime() - WEEK);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK);
  const [upNow, upPrev, model, modelPrev, sums] = await Promise.all([
    uptime(db, now, 7),
    uptime(db, weekAgo, 7),
    modelWindowStats(db, weekAgo, now),
    modelWindowStats(db, twoWeeksAgo, weekAgo),
    db.execute<{ tokens: number; tokens_prev: number; incidents: number; incidents_prev: number }>(sql`
      SELECT (SELECT coalesce(sum(input_tokens + output_tokens), 0)::float8 FROM usage_events WHERE occurred_at >= ${at(weekAgo)} AND occurred_at < ${at(now)}) AS tokens,
             (SELECT coalesce(sum(input_tokens + output_tokens), 0)::float8 FROM usage_events WHERE occurred_at >= ${at(twoWeeksAgo)} AND occurred_at < ${at(weekAgo)}) AS tokens_prev,
             (SELECT count(*)::int FROM alerts WHERE kind = 'TECHNICAL' AND opened_at >= ${at(weekAgo)} AND opened_at < ${at(now)}) AS incidents,
             (SELECT count(*)::int FROM alerts WHERE kind = 'TECHNICAL' AND opened_at >= ${at(twoWeeksAgo)} AND opened_at < ${at(weekAgo)}) AS incidents_prev`),
  ]);
  const s = sums.rows[0];
  return [
    { key: 'uptime', label: 'Uptime', value: upNow.ratio, unit: '%', previous: upPrev.ratio, betterWhen: 'up', period: '7d', href: '/system' },
    { key: 'ttft_p95', label: 'Time to first token (p95)', value: model.ttftP95Ms, unit: 'ms', previous: modelPrev.ttftP95Ms, betterWhen: 'down', period: '7d', href: '/system/telemetry' },
    { key: 'model_errors', label: 'Model error rate', value: model.errorRate, unit: '%', previous: modelPrev.errorRate, betterWhen: 'down', period: '7d', href: '/system/telemetry' },
    { key: 'incidents', label: 'Incidents opened', value: int(s?.incidents), unit: 'count', previous: int(s?.incidents_prev), betterWhen: 'down', period: '7d', href: '/alerts?kind=technical' },
    { key: 'tokens', label: 'Tokens used', value: int(s?.tokens), unit: 'count', previous: int(s?.tokens_prev), betterWhen: 'none', period: '7d', href: '/system/telemetry' },
  ];
}
