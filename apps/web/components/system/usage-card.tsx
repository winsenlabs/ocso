import { EmptyState } from '@/components/ui/empty-state';
import { HBarChart } from '@/components/ui/hbar-chart';
import { MetricMatrix } from '@/components/ui/metric-matrix';
import type { TokenUsage } from '@/lib/api/telemetry';
import { formatCompact, formatNumber, formatPercent } from '@/lib/format';
import { formatMoney } from './system-meta';

/** Cache figures are null when no request reported them — shown as "—" (the foot says why), never zero. */
const cacheValue = (v: number | null) => (v === null ? '—' : formatCompact(v));

/**
 * Token usage and cache · today (design/03). Prompt caching is first-class:
 * cache reads/writes and the cached share of input sit beside the raw tokens.
 */
export function UsageCard({ usage, title = 'Token usage and cache · today' }: { usage: TokenUsage; title?: string }) {
  const t = usage.totals;
  const profiles = usage.byProfile.filter((p) => p.inputTokens + p.outputTokens > 0);
  return (
    <section className="ch" aria-label={title}>
      <div className="t">
        <h3>{title}</h3>
        <span className="mono-sm" style={{ marginLeft: 'auto' }}>
          {formatNumber(t.requests)} requests
        </span>
      </div>
      <MetricMatrix
        columns={4}
        metrics={[
          { label: 'input tokens', value: formatCompact(t.inputTokens) },
          { label: 'output tokens', value: formatCompact(t.outputTokens) },
          { label: 'cache read', value: cacheValue(t.cacheReadTokens) },
          { label: 'cache write', value: cacheValue(t.cacheWriteTokens) },
        ]}
      />
      {profiles.length ? (
        <HBarChart
          label="Token share by model profile"
          columns="minmax(90px,1fr) minmax(0,2fr) 54px"
          rows={profiles.map((p) => ({
            label: p.profileName ?? 'no profile',
            share: p.tokenShare ?? 0,
            display: formatPercent(p.tokenShare, 0),
            tone: 'a',
          }))}
        />
      ) : (
        <EmptyState size="sm" title="No model requests today">
          Tokens by model profile appear with the first model request.
        </EmptyState>
      )}
      <div className="foot">
        <span className="mono-sm">
          {t.costMicros === null ? 'cost not priced' : `≈ ${formatMoney(t.costMicros, t.currency)} today`}
          {' · '}
          {t.cachedInputShare === null ? 'cache hit rate not reported yet' : `${formatPercent(t.cachedInputShare)} of input served from cache`}
          {t.reasoningTokens ? ` · ${formatCompact(t.reasoningTokens)} reasoning` : ''}
        </span>
      </div>
    </section>
  );
}
