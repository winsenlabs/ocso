import { sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import type { InternalTool } from '../contract.js';

const Window = z.object({ minutes: z.number().int().min(5).max(10_080).default(60) });
type Window = z.infer<typeof Window>;

/** Latency investigation: p95 turn latency and TTFT per bucket, provider errors and fallbacks. */
export const latencyBreakdown: InternalTool<Window> = {
  name: 'latency_breakdown',
  description:
    'Explain latency: p95 turn latency and time-to-first-token per time bucket, per-provider error rates and fallbacks over the window. Use for "why did latency spike".',
  input: Window,
  permission: Permission.TELEMETRY_TECHNICAL_READ,
  risk: 'READ',
  async run(ctx, { minutes }) {
    const bucket = Math.max(1, Math.round(minutes / 12));
    const model = await ctx.db.execute<{ bucket: Date; ttft_p95: number | null; errors: number; requests: number; fallbacks: number }>(sql`
      SELECT date_bin(make_interval(mins => ${bucket}), occurred_at, TIMESTAMPTZ '2000-01-01') AS bucket,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ttft_ms) AS ttft_p95,
             count(*) FILTER (WHERE status = 'ERROR')::int AS errors,
             count(*)::int AS requests,
             count(*) FILTER (WHERE fallback_from_provider_id IS NOT NULL)::int AS fallbacks
        FROM usage_events
       WHERE occurred_at > now() - make_interval(mins => ${minutes})
       GROUP BY 1 ORDER BY 1`);
    const turnRows = await ctx.db.execute<{ bucket: Date; turn_p95: number | null }>(sql`
      SELECT date_bin(make_interval(mins => ${bucket}), completed_at, TIMESTAMPTZ '2000-01-01') AS bucket,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS turn_p95
        FROM turns
       WHERE completed_at > now() - make_interval(mins => ${minutes}) AND status = 'COMPLETED'
       GROUP BY 1`);
    const turnP95 = new Map(turnRows.rows.map((r) => [new Date(r.bucket).getTime(), r.turn_p95]));
    const series = { rows: model.rows.map((r) => ({ ...r, turn_p95: turnP95.get(new Date(r.bucket).getTime()) ?? null })) };
    const providers = await ctx.db.execute<{ name: string; requests: number; errors: number; p95: number | null; top_error: string | null }>(sql`
      SELECT p.name, count(*)::int AS requests, count(*) FILTER (WHERE u.status = 'ERROR')::int AS errors,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY u.ttft_ms) AS p95,
             mode() WITHIN GROUP (ORDER BY u.error_category) FILTER (WHERE u.status = 'ERROR') AS top_error
        FROM usage_events u JOIN model_providers p ON p.id = u.provider_id
       WHERE u.occurred_at > now() - make_interval(mins => ${minutes})
       GROUP BY p.name ORDER BY errors DESC`);
    const fmt = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
    return {
      data: { bucketMinutes: bucket, series: series.rows, providers: providers.rows },
      table: {
        columns: ['Window', 'TTFT p95', 'Err'],
        rows: series.rows.slice(-6).map((r) => [new Date(r.bucket).toISOString().slice(11, 16), fmt(r.ttft_p95), r.requests ? `${((r.errors / r.requests) * 100).toFixed(1)}%` : '—']),
      },
      links: providers.rows
        .filter((p) => p.errors > 0)
        .slice(0, 2)
        .map((p) => ({ label: `${p.name} · provider health`, detail: `${p.errors}/${p.requests} errors · ${p.top_error ?? 'error'}`, href: '/system', status: 'danger' as const })),
    };
  },
};

export const promptCacheStats: InternalTool<Window> = {
  name: 'prompt_cache_stats',
  description:
    'Prompt-cache hit rate: share of input tokens served from provider caches, by provider and model profile, plus cache writes. Providers that do not report cache metrics are listed as not reported.',
  input: Window,
  permission: Permission.TELEMETRY_TECHNICAL_READ,
  risk: 'READ',
  async run(ctx, { minutes }) {
    const { rows } = await ctx.db.execute<{ provider: string; profile: string; input: number; cached: number | null; writes: number | null; reported: number }>(sql`
      SELECT p.name AS provider, coalesce(mp.name, '—') AS profile,
             sum(u.input_tokens)::bigint AS input, sum(u.cached_input_tokens)::bigint AS cached,
             sum(u.cache_write_tokens)::bigint AS writes, count(u.cached_input_tokens)::int AS reported
        FROM usage_events u
        JOIN model_providers p ON p.id = u.provider_id
        LEFT JOIN model_profiles mp ON mp.id = u.profile_id
       WHERE u.occurred_at > now() - make_interval(mins => ${minutes}) AND u.status = 'OK'
       GROUP BY p.name, mp.name ORDER BY input DESC`);
    const ratio = (r: (typeof rows)[number]) => (r.reported && Number(r.input) ? Number(r.cached ?? 0) / Number(r.input) : null);
    return {
      data: rows.map((r) => ({ ...r, input: Number(r.input), cached: r.cached === null ? null : Number(r.cached), hitRatio: ratio(r) })),
      table: { columns: ['Profile', 'Provider', 'Cache read'], rows: rows.map((r) => [r.profile, r.provider, ratio(r) === null ? 'not reported' : `${(ratio(r)! * 100).toFixed(1)}%`]) },
    };
  },
};

export const mcpHealth: InternalTool<Window> = {
  name: 'mcp_health',
  description: 'MCP connection health and tool failure rates over the window. Use for "which MCP server is failing".',
  input: Window,
  permission: Permission.MCP_READ,
  risk: 'READ',
  async run(ctx, { minutes }) {
    const { rows } = await ctx.db.execute<{ id: string; name: string; status: string; last_error: string | null; calls: number; failed: number; top_tool: string | null }>(sql`
      SELECT c.id, c.name, c.status, c.last_error,
             count(tc.id)::int AS calls, count(tc.id) FILTER (WHERE tc.status = 'FAILED')::int AS failed,
             mode() WITHIN GROUP (ORDER BY tc.tool_name) FILTER (WHERE tc.status = 'FAILED') AS top_tool
        FROM mcp_connections c
        LEFT JOIN tool_calls tc ON tc.connection_id = c.id AND tc.requested_at > now() - make_interval(mins => ${minutes})
       WHERE c.scope = 'SHARED'
       GROUP BY c.id ORDER BY failed DESC, c.name`);
    return {
      data: rows,
      links: rows
        .filter((r) => r.failed > 0 || r.status !== 'ACTIVE')
        .map((r) => ({ label: `${r.name} · ${r.status.toLowerCase()}`, detail: `${r.failed}/${r.calls} calls failed${r.top_tool ? ` · mostly ${r.top_tool}` : ''}`, href: '/connections?tab=mcp', status: r.status === 'ACTIVE' ? ('warn' as const) : ('danger' as const) })),
    };
  },
};
