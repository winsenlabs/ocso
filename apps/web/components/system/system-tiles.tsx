import { Tile, Tiles } from '@/components/ui/tile';
import type { TelemetryOverview } from '@/lib/api/telemetry';
import { formatCompact, formatDuration, formatLatency, formatNumber, formatPercent } from '@/lib/format';

/**
 * Tech Admin tile row (design/03): last-hour window except the "today" figures.
 * Tool failure is the worst tool over 24 h with at least 5 finished calls; "none" when no such tool failed.
 */
export function SystemTiles({ overview, scaleOutQueueAgeSeconds }: { overview: TelemetryOverview; scaleOutQueueAgeSeconds: number | null }) {
  const t = overview.tiles;
  const age = t.queue.turnOldestAgeSeconds;
  const queueWarn = scaleOutQueueAgeSeconds !== null && age !== null && age > scaleOutQueueAgeSeconds;
  const worst = t.worstToolFailure;
  return (
    <Tiles min={134}>
      <Tile label="active conversations" value={formatNumber(t.activeConversations)} />
      <Tile
        label="healthy workers"
        value={`${t.healthyWorkers.healthy} of ${t.healthyWorkers.max}`}
        {...(t.healthyWorkers.healthy < t.healthyWorkers.minWarm ? { tone: 'warn' as const } : {})}
      />
      <Tile
        label={`queue depth${age !== null ? ` · oldest ${formatDuration(age)}` : ''}`}
        value={formatNumber(t.queue.depth)}
        {...(queueWarn ? { tone: 'warn' as const } : {})}
      />
      <Tile label="turn latency p95" value={t.turnLatencyP95Ms === null ? null : formatLatency(t.turnLatencyP95Ms)} />
      <Tile label="time to first token" value={t.ttftP95Ms === null ? null : formatLatency(t.ttftP95Ms)} />
      <Tile label="requests / min" value={formatNumber(t.requestsPerMinute, t.requestsPerMinute < 10 ? 1 : 0)} />
      <Tile label="tokens today" value={formatCompact(t.tokensToday)} />
      <Tile label="cached input tokens" value={t.cachedInputShareToday === null ? null : formatPercent(t.cachedInputShareToday)} />
      <Tile
        label="provider error rate"
        value={t.providerErrorRate === null ? null : formatPercent(t.providerErrorRate)}
        {...(t.providerErrorRate !== null && t.providerErrorRate > 0.05 ? { tone: 'warn' as const } : {})}
      />
      <Tile
        label={worst ? `tool failure · ${worst.toolName}` : 'tool failure · 24h'}
        value={worst ? formatPercent(worst.failureRate) : 'none'}
        {...(worst ? { tone: 'warn' as const } : {})}
      />
    </Tiles>
  );
}
