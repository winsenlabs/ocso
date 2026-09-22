/**
 * Display rules for the Tech Admin control center (design/03). Pure and
 * client-safe; every tone follows the API's own status, never a guess.
 */
import type { StatusTone } from '@/components/ui/status-chip';

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** .okdot modifier: green ok, amber degraded, red down, grey unknown. */
export function dotClass(status: ServiceStatus): string {
  return { ok: 'okdot', degraded: 'okdot w', down: 'okdot d', unknown: 'okdot m' }[status];
}

export function overallTone(status: ServiceStatus): '' | 'bad' {
  return status === 'down' || status === 'degraded' ? 'bad' : '';
}

const WORKER_STATUS: Record<string, { tone: StatusTone; label: string }> = {
  HEALTHY: { tone: 'good', label: 'healthy' },
  STALE: { tone: 'warn', label: 'stale heartbeat' },
  DRAINING: { tone: 'warn', label: 'draining' },
  STARTING: { tone: 'accent', label: 'starting' },
  LOST: { tone: 'danger', label: 'lost' },
  STOPPED: { tone: 'muted', label: 'stopped' },
};

export function workerChip(effectiveStatus: string): { tone: StatusTone; label: string } {
  return WORKER_STATUS[effectiveStatus] ?? { tone: 'muted', label: effectiveStatus.toLowerCase() };
}

/** Utilisation bar tone (.util > i.w / i.d). */
export function utilClass(utilization: number | null): string | undefined {
  if (utilization === null) return undefined;
  if (utilization >= 0.95) return 'd';
  if (utilization >= 0.85) return 'w';
  return undefined;
}

/** Provider card chip and border from model_providers.status and last-hour traffic. */
export function providerChip(p: { enabled: boolean; status: string; profiles: unknown[]; errorRate: number | null }): {
  tone: StatusTone;
  label: string;
  card?: 'warn' | 'danger';
} {
  if (!p.enabled) return { tone: 'muted', label: 'disabled' };
  if (p.status === 'DOWN') return { tone: 'danger', label: 'down', card: 'danger' };
  if (p.status === 'DEGRADED') return { tone: 'warn', label: 'degraded', card: 'warn' };
  if (p.errorRate !== null && p.errorRate > 0.05) return { tone: 'warn', label: 'elevated', card: 'warn' };
  if (p.profiles.length === 0) return { tone: 'muted', label: 'standby' };
  if (p.status === 'UNKNOWN' || p.status === 'UNTESTED') return { tone: 'muted', label: 'untested' };
  return { tone: 'good', label: 'ok' };
}

const MCP_STATUS: Record<string, { tone: StatusTone; label: string }> = {
  HEALTHY: { tone: 'good', label: 'healthy' },
  ACTIVE: { tone: 'good', label: 'healthy' },
  DEGRADED: { tone: 'danger', label: 'degraded' },
  DOWN: { tone: 'danger', label: 'down' },
  AUTH_REQUIRED: { tone: 'warn', label: 'auth required' },
  DISABLED: { tone: 'muted', label: 'disabled' },
  PENDING: { tone: 'muted', label: 'pending' },
  PENDING_APPROVAL: { tone: 'muted', label: 'pending approval' },
};

export function mcpChip(status: string): { tone: StatusTone; label: string } {
  return MCP_STATUS[status] ?? { tone: 'muted', label: status.toLowerCase().replace(/_/g, ' ') };
}

/** Cache read share for a provider card: observed, never assumed. */
export function cacheLabel(share: number | null, support: 'REPORTED' | 'NOT_REPORTED' | 'NO_TRAFFIC'): string {
  if (support === 'NO_TRAFFIC') return '—';
  if (support === 'NOT_REPORTED' || share === null) return 'not reported';
  return `${Math.round(share * 1000) / 10}%`;
}

/** Cost in minor-unit micros → "₹18,400" style: 2 decimals under 100, whole units above. */
export function formatMoney(micros: number | null, currency: string | null): string {
  if (micros === null || !currency) return '—';
  const amount = micros / 1_000_000;
  if (currency === 'MIXED') return `${amount.toFixed(2)} (mixed currencies)`;
  const digits = amount >= 100 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

/** 1843 MB → "1.8 GB"; 512 → "512 MB". */
export function formatMemory(mb: number | null): string {
  if (mb === null) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Short worker id as in the design ("wkr-7f21a"): hostname when short, else the id prefix. */
export function workerLabel(w: { id: string; hostname: string }): string {
  return w.hostname && w.hostname.length <= 24 ? w.hostname : `wkr-${w.id.replace(/-/g, '').slice(-5)}`;
}

/** Queue age against the scale-out threshold: warn when it crosses it. */
export function queueAgeTone(ageSeconds: number | null, thresholdSeconds: number): 'warn' | undefined {
  return ageSeconds !== null && ageSeconds > thresholdSeconds ? 'warn' : undefined;
}

/** Downsample a per-minute series to at most `max` points (max over each bucket keeps spikes). */
export function bucketMax(values: Array<number | null>, max: number): Array<number | null> {
  if (values.length <= max) return values;
  const size = Math.ceil(values.length / max);
  const out: Array<number | null> = [];
  for (let i = 0; i < values.length; i += size) {
    const slice = values.slice(i, i + size).filter((v): v is number => v !== null);
    out.push(slice.length ? Math.max(...slice) : null);
  }
  return out;
}
