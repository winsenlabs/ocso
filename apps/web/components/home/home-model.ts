/**
 * Pure helpers for the role Home (HOME contract): trend maths and copy for
 * the tiles, "needs you" presentation, and the service-flow graph. Client-safe
 * and free of React so the unit tests cover every rule the page shows.
 */

import { formatDuration, formatLatency, formatNumber, formatPercent } from '@/lib/format';

export type TileUnit = '%' | 'ms' | 's' | 'count' | 'score';
export type BetterWhen = 'up' | 'down' | 'none';
export type Severity = 'critical' | 'high' | 'normal';

/* ─────────── Trend tiles ─────────── */

/** A tile value as the rest of OCSO writes it; `%` values arrive as ratios (0.798). */
export function formatTileValue(value: number | null, unit: TileUnit | null | undefined): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  switch (unit) {
    case '%':
      return formatPercent(value);
    case 'ms':
      return formatLatency(value);
    case 's':
      return formatDuration(value);
    case 'score':
      return formatNumber(value, 1);
    default:
      return formatNumber(value);
  }
}

export interface Trend {
  direction: 'up' | 'down' | 'flat';
  /** good / bad by `betterWhen`; neutral when the direction carries no judgement or nothing moved. */
  tone: 'good' | 'bad' | 'neutral';
  /** Short visible delta, e.g. "12%" or "3" or "1.4 pts"; null when there is nothing to compare. */
  label: string | null;
  /** Screen-reader sentence, e.g. "up 12% vs previous 7 days". */
  sr: string;
}

/**
 * Change vs the previous period. Percent-unit tiles move in points (a ratio
 * of ratios reads wrong); counts and times move in percent of the previous
 * value, except from zero where only the absolute change is honest.
 */
export function trendOf(value: number | null, previous: number | null, betterWhen: BetterWhen, unit: TileUnit | null | undefined, period: string): Trend {
  if (value === null || previous === null || !Number.isFinite(value) || !Number.isFinite(previous)) {
    return { direction: 'flat', tone: 'neutral', label: null, sr: `no comparison with ${period}` };
  }
  const diff = value - previous;
  const epsilon = unit === '%' ? 0.0005 : 1e-9;
  if (Math.abs(diff) < epsilon) return { direction: 'flat', tone: 'neutral', label: 'no change', sr: `no change vs ${period}` };
  const direction = diff > 0 ? 'up' : 'down';
  const tone = betterWhen === 'none' ? 'neutral' : direction === betterWhen ? 'good' : 'bad';
  let label: string;
  if (unit === '%') {
    label = `${trimNumber(Math.abs(diff) * 100)} pts`;
  } else if (previous === 0) {
    const abs = Math.abs(diff);
    label = unit === 'ms' ? formatLatency(abs) : unit === 's' ? formatDuration(abs) : unit === 'score' ? formatNumber(abs, 1) : formatNumber(abs);
  } else {
    label = `${trimNumber((Math.abs(diff) / Math.abs(previous)) * 100)}%`;
  }
  return { direction, tone, label, sr: `${direction} ${label} vs ${period}` };
}

/** 12 → "12", 3.456 → "3.5", 0.04 → "<0.1". */
function trimNumber(n: number): string {
  if (n > 0 && n < 0.1) return '<0.1';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

/** The comparison window a role's tiles use by default (HOME contract): Service compares today with yesterday. */
export function periodLabel(role: 'TECH' | 'HEAD' | 'SERVICE'): string {
  return role === 'SERVICE' ? 'yesterday' : 'previous 7 days';
}

/** The comparison window for one tile from the period its value covers; the role default when it does not say. */
export function comparedWith(period: string | null | undefined, fallback: string): string {
  switch (period) {
    case 'today':
      return 'yesterday';
    case '7d':
      return 'previous 7 days';
    case '24h':
      return 'previous 24 hours';
    case '30d':
      return 'previous 30 days';
    default:
      return fallback;
  }
}

/* ─────────── Needs you ─────────── */

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, normal: 2 };

export interface NeedsYouLike {
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  detail?: string | null | undefined;
  at: string;
  href: string;
  askOcso?: string | null | undefined;
}

/**
 * The API ranks the list; items the page adds (lead decisions) join by
 * severity without disturbing that order (stable), duplicates by id dropped.
 */
export function mergeNeedsYou<T extends NeedsYouLike>(ranked: readonly T[], extra: readonly T[]): T[] {
  const seen = new Set<string>();
  const all = [...ranked, ...extra].filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  return all
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] || a.index - b.index)
    .map((x) => x.item);
}

const KIND_LABEL: Record<string, string> = {
  approval_to_decide: 'approval',
  proposal_returned: 'your proposal',
  escalation_waiting: 'escalation',
  sla_at_risk: 'sla',
  alert: 'alert',
  exception: 'exception',
  channel_down: 'channel',
  provider_down: 'provider',
  grant_expiring: 'access',
  routing_stuck: 'routing',
  setup: 'setup',
  decision: 'decision',
  offer: 'offer',
};

/** Mono caption for the item's kind; unknown kinds from a newer API read as their words. */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/[_-]+/g, ' ').toLowerCase();
}

/**
 * The time caption for an item: "due in 12m" for times ahead (an SLA, a grant
 * expiry), "22m ago" / "waiting 22m" otherwise. Nothing when `at` is the
 * snapshot time itself (the API and page stamp live conditions — a channel
 * down, a setup step, a lead decision — with it): "0s ago" would mean nothing.
 * A queue item (`queue:<id>`) carries when its oldest conversation started
 * waiting, not a due time, so it reads as a wait even when its kind is an SLA risk.
 */
export function whenLabel(item: { kind: string; at: string; id?: string }, now: Date = new Date()): string {
  const { kind, at } = item;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const diff = Math.round((t - now.getTime()) / 1000);
  if (diff === 0) return '';
  if (item.id?.startsWith('queue:')) return diff < 0 ? `oldest waiting ${shortSpan(-diff)}` : '';
  if (diff > 0) return kind === 'grant_expiring' ? `expires in ${shortSpan(diff)}` : `due in ${shortSpan(diff)}`;
  const ago = shortSpan(-diff);
  if (kind === 'escalation_waiting' || kind === 'routing_stuck') return `waiting ${ago}`;
  if (kind === 'sla_at_risk') return `overdue ${ago}`;
  return `${ago} ago`;
}

function shortSpan(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/* ─────────── Service flow ─────────── */

export interface FlowGraph {
  channels: Array<{ id: string }>;
  routers: Array<{ id: string; channelIds: string[] }>;
  queues: Array<{ id: string; routerIds: string[]; agentId: string | null }>;
  agents: Array<{ id: string; queueIds: string[] }>;
}

/** Node key in the flow: `${column}:${id}` (ids are only unique per object type). */
export type FlowKey = `${'c' | 'r' | 'q' | 'a'}:${string}`;

/**
 * Everything connected to one node, walking both ways through the columns
 * (channel → router → queue → agent), so hovering or focusing a node can
 * light its whole path.
 */
export function flowNeighbours(graph: FlowGraph): Map<FlowKey, Set<FlowKey>> {
  const edges = new Map<FlowKey, Set<FlowKey>>();
  const link = (a: FlowKey, b: FlowKey) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  const ids = { c: new Set(graph.channels.map((c) => c.id)), r: new Set(graph.routers.map((r) => r.id)), q: new Set(graph.queues.map((q) => q.id)), a: new Set(graph.agents.map((a) => a.id)) };
  for (const r of graph.routers) for (const c of r.channelIds) if (ids.c.has(c)) link(`r:${r.id}`, `c:${c}`);
  for (const q of graph.queues) {
    for (const r of q.routerIds) if (ids.r.has(r)) link(`q:${q.id}`, `r:${r}`);
    if (q.agentId && ids.a.has(q.agentId)) link(`q:${q.id}`, `a:${q.agentId}`);
  }
  for (const a of graph.agents) for (const q of a.queueIds) if (ids.q.has(q)) link(`a:${a.id}`, `q:${q}`);

  // Downstream-only and upstream-only walks, so a channel lights the routers, queues and agents it feeds, not siblings.
  const order: Record<string, number> = { c: 0, r: 1, q: 2, a: 3 };
  const col = (k: FlowKey) => order[k.charAt(0)]!;
  const result = new Map<FlowKey, Set<FlowKey>>();
  for (const start of edges.keys()) {
    const seen = new Set<FlowKey>([start]);
    for (const dir of [1, -1] as const) {
      let frontier: FlowKey[] = [start];
      while (frontier.length) {
        const next: FlowKey[] = [];
        for (const k of frontier) {
          for (const n of edges.get(k) ?? []) {
            if (col(n) - col(k) === dir && !seen.has(n)) {
              seen.add(n);
              next.push(n);
            }
          }
        }
        frontier = next;
      }
    }
    seen.delete(start);
    result.set(start, seen);
  }
  return result;
}

/** Names of the upstream objects, for the "from …" caption that stands in for connector lines. */
export function namesOf(ids: readonly string[], byId: ReadonlyMap<string, { name: string }>, max = 2): string | null {
  const names = ids.flatMap((id) => {
    const n = byId.get(id)?.name;
    return n ? [n] : [];
  });
  if (!names.length) return null;
  return names.length > max ? `${names.slice(0, max).join(', ')} +${names.length - max}` : names.join(', ');
}

/** Status words the API uses for healthy objects; anything else earns a problem badge. */
const HEALTHY = new Set(['active', 'live', 'ok', 'healthy', 'enabled', 'up', 'running', 'connected']);

export function isHealthyStatus(status: string): boolean {
  return HEALTHY.has(status.toLowerCase());
}
