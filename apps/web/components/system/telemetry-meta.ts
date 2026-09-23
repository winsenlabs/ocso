/**
 * Display rules for /system/telemetry (percentiles and request purposes).
 * Pure and client-safe; values come from the telemetry API as-is.
 */
import type { LatencyWindow } from '@/lib/api/telemetry';
import { formatLatency } from '../../lib/format';

/** usage_events.purpose → what the requests are for (packages/application telemetry USAGE_PURPOSES). */
const PURPOSES: Readonly<Record<string, { label: string; hint: string }>> = {
  TURN: { label: 'Customer turns', hint: 'agent replies to customers' },
  SUMMARY: { label: 'Summaries', hint: 'rolling summaries and handover notes' },
  COPILOT: { label: 'Copilot', hint: 'suggestions for humans' },
  INTERNAL_AGENT: { label: 'Internal agent', hint: 'the OCSO assistant for staff' },
  CLASSIFIER: { label: 'Classifier', hint: 'insights and labels' },
  EVALUATION: { label: 'Evaluations', hint: 'prompt replay evaluations' },
  TEST: { label: 'Tests', hint: 'provider and profile tests' },
};

export function purposeLabel(purpose: string): { label: string; hint: string } {
  return PURPOSES[purpose] ?? { label: purpose.toLowerCase().replace(/_/g, ' '), hint: 'other requests' };
}

/** "1.2s · 3.9s" (p50 · p95); null when neither is known so the tile says "no data yet". */
export function percentilePair(p50: number | null, p95: number | null): string | null {
  if (p50 === null && p95 === null) return null;
  return `${formatLatency(p50)} · ${formatLatency(p95)}`;
}

export interface PercentileRow {
  key: 'turn' | 'ttft';
  metric: string;
  source: string;
  p50: number | null;
  p95: number | null;
  samples: number;
}

/** Window percentiles as table rows: end-to-end turn latency and time to first token. */
export function percentileRows(w: LatencyWindow): PercentileRow[] {
  return [
    { key: 'turn', metric: 'Turn latency', source: 'completed turns, end to end', p50: w.turnP50Ms, p95: w.turnP95Ms, samples: w.turns },
    { key: 'ttft', metric: 'Time to first token', source: 'successful customer-turn model requests', p50: w.ttftP50Ms, p95: w.ttftP95Ms, samples: w.ttftRequests },
  ];
}

/** "Last 1h" / "Last 3h" for a window in minutes. */
export function windowLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
