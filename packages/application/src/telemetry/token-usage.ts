import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { at, int, num, ratio } from '../analytics/values.js';

export interface TokenTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of reported cache reads; null when no request in the window reported cache metrics. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  /** cache reads / input tokens of requests whose provider reports cache reads. */
  cachedInputShare: number | null;
  costMicros: number | null;
  currency: string | null;
}

export interface ProfileUsage extends TokenTotals {
  profileId: string | null;
  profileName: string | null;
  /** (input + output) of this profile / (input + output) of all profiles. */
  tokenShare: number | null;
}

/** usage_events.purpose values in display order (docs/05 §3); unknown purposes sort after these. */
export const USAGE_PURPOSES = ['TURN', 'SUMMARY', 'COPILOT', 'INTERNAL_AGENT', 'CLASSIFIER', 'EVALUATION', 'TEST'] as const;

export interface PurposeUsage extends TokenTotals {
  purpose: string;
  /** (input + output) of this purpose / (input + output) of all requests. */
  tokenShare: number | null;
}

export interface TokenUsage {
  from: string;
  to: string;
  totals: TokenTotals;
  byProfile: ProfileUsage[];
  byPurpose: PurposeUsage[];
  definitions: Record<string, string>;
}

type Row = {
  profile_id: string | null;
  profile_name: string | null;
  purpose: string | null;
  g_profile: number;
  g_purpose: number;
  requests: number;
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
  reported_input: number | null;
  cost: number | null;
  currencies: string[] | null;
};

function totals(r: Row | undefined): TokenTotals {
  const currencies = r?.currencies ?? [];
  const cacheRead = num(r?.cache_read);
  const reportedInput = num(r?.reported_input);
  return {
    requests: int(r?.requests),
    inputTokens: int(r?.input),
    outputTokens: int(r?.output),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: num(r?.cache_write),
    reasoningTokens: num(r?.reasoning),
    cachedInputShare: cacheRead !== null && reportedInput ? cacheRead / reportedInput : null,
    costMicros: num(r?.cost),
    currency: currencies.length === 0 ? null : currencies.length === 1 ? currencies[0]! : 'MIXED',
  };
}

const purposeRank = (p: string) => {
  const i = (USAGE_PURPOSES as readonly string[]).indexOf(p);
  return i === -1 ? USAGE_PURPOSES.length : i;
};

/**
 * Token, cache and cost totals for [from, to) with the share per model profile
 * and per request purpose (design/03 "Token usage and cache · today"). One row
 * per model request attempt in usage_events (usage_events_time_idx), grouped
 * once with GROUPING SETS. `null` = not reported.
 */
export async function tokenUsage(db: DbOrTx, from: Date, to: Date): Promise<TokenUsage> {
  const { rows } = await db.execute<Row>(sql`
    SELECT u.profile_id, max(mp.name) AS profile_name, u.purpose,
           grouping(u.profile_id) AS g_profile, grouping(u.purpose) AS g_purpose,
           count(*)::int AS requests,
           coalesce(sum(u.input_tokens), 0)::float8 AS input,
           coalesce(sum(u.output_tokens), 0)::float8 AS output,
           sum(u.cached_input_tokens)::float8 AS cache_read,
           sum(u.cache_write_tokens)::float8 AS cache_write,
           sum(u.reasoning_tokens)::float8 AS reasoning,
           (sum(u.input_tokens) FILTER (WHERE u.cached_input_tokens IS NOT NULL))::float8 AS reported_input,
           sum(u.cost_micros)::float8 AS cost,
           array_agg(DISTINCT u.currency) FILTER (WHERE u.currency IS NOT NULL) AS currencies
      FROM usage_events u
      LEFT JOIN model_profiles mp ON mp.id = u.profile_id
     WHERE u.occurred_at >= ${at(from)} AND u.occurred_at < ${at(to)}
     GROUP BY GROUPING SETS ((u.profile_id), (u.purpose), ())`);
  const total = totals(rows.find((r) => int(r.g_profile) === 1 && int(r.g_purpose) === 1));
  const allTokens = total.inputTokens + total.outputTokens;
  const byProfile = rows
    .filter((r) => int(r.g_profile) === 0)
    .map((r): ProfileUsage => {
      const t = totals(r);
      return { ...t, profileId: r.profile_id, profileName: r.profile_name, tokenShare: ratio(t.inputTokens + t.outputTokens, allTokens) };
    })
    .sort((a, b) => (b.tokenShare ?? 0) - (a.tokenShare ?? 0));
  const byPurpose = rows
    .filter((r) => int(r.g_purpose) === 0)
    .map((r): PurposeUsage => {
      const t = totals(r);
      return { ...t, purpose: r.purpose ?? 'UNKNOWN', tokenShare: ratio(t.inputTokens + t.outputTokens, allTokens) };
    })
    .sort((a, b) => purposeRank(a.purpose) - purposeRank(b.purpose) || a.purpose.localeCompare(b.purpose));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: total,
    byProfile,
    byPurpose,
    definitions: {
      cachedInputShare: 'Sum of cached input tokens / sum of input tokens, over requests whose provider reported cache reads (others are excluded, not counted as misses).',
      tokenShare: '(input + output tokens) of the profile (or purpose) / (input + output tokens) of all requests in the window.',
      byPurpose: 'usage_events grouped by purpose (TURN = customer turns, SUMMARY, COPILOT, INTERNAL_AGENT, CLASSIFIER, EVALUATION, TEST); requests counts every attempt including errors and fallbacks; cache and cost columns follow the same rules as the totals.',
      costMicros: 'Sum of usage_events.cost_micros (priced from model_pricing at request time); requests without a price are not included.',
    },
  };
}
