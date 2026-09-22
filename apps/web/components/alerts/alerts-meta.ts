/**
 * Alert display rules and URL model (docs/11 §6). Pure and client-safe.
 * The /alerts screen keeps its filters, tab and open drawer in the URL so
 * links from the home and control center land on the same view.
 */
import type { StatusTone } from '@/components/ui/status-chip';

export const SEVERITY_TONE: Record<string, StatusTone> = { CRITICAL: 'danger', WARNING: 'warn', INFO: 'muted' };
export const STATE_CHIP: Record<string, { tone: StatusTone; label: string }> = {
  OPEN: { tone: 'warn', label: 'unacked' },
  ACKNOWLEDGED: { tone: 'muted', label: 'acked' },
  RESOLVED: { tone: 'good', label: 'resolved' },
};
export const DELIVERY_TONE: Record<string, StatusTone> = { SENT: 'good', PENDING: 'muted', FAILED: 'danger', SKIPPED: 'muted' };

export const ROLE_LABEL: Record<string, string> = { PLATFORM_TECH_ADMIN: 'Tech Admin', CS_LEAD: 'CS Lead', CS_EXEC: 'CS Exec' };
export const DESTINATION_LABEL: Record<string, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email (SMTP)',
  SLACK: 'Slack',
  TEAMS: 'Microsoft Teams',
  WEBHOOK: 'Webhook (HMAC-signed)',
  PAGERDUTY: 'PagerDuty',
};

export type AlertTab = 'inbox' | 'rules' | 'destinations';
export type StatusFilter = 'UNRESOLVED' | 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'ALL';

export interface AlertsParams {
  tab?: AlertTab | undefined;
  status?: StatusFilter | undefined;
  kind?: 'TECHNICAL' | 'BUSINESS' | undefined;
  severity?: 'CRITICAL' | 'WARNING' | 'INFO' | undefined;
  /** Open alert drawer. */
  alert?: string | undefined;
  /** Rule / destination dialog: an id or "new". */
  rule?: string | undefined;
  destination?: string | undefined;
  cursor?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly StatusFilter[] = ['UNRESOLVED', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ALL'];

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v ? v : undefined;
}

/** Parse search params into a safe model: unknown values are dropped, ids must be UUIDs. */
export function parseAlertsParams(raw: Record<string, string | string[] | undefined>): AlertsParams {
  const tab = first(raw['tab']);
  const status = first(raw['status'])?.toUpperCase();
  const kind = first(raw['kind'])?.toUpperCase();
  const severity = first(raw['severity'])?.toUpperCase();
  const idOrNew = (v: string | undefined) => (v === 'new' || (v && UUID.test(v)) ? v : undefined);
  const alert = first(raw['alert']);
  const cursor = first(raw['cursor']);
  return {
    tab: tab === 'rules' || tab === 'destinations' ? tab : 'inbox',
    status: STATUSES.find((s) => s === status) ?? 'UNRESOLVED',
    kind: kind === 'TECHNICAL' || kind === 'BUSINESS' ? kind : undefined,
    severity: severity === 'CRITICAL' || severity === 'WARNING' || severity === 'INFO' ? severity : undefined,
    alert: alert && UUID.test(alert) ? alert : undefined,
    rule: idOrNew(first(raw['rule'])),
    destination: idOrNew(first(raw['destination'])),
    cursor: cursor && /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? cursor : undefined,
  };
}

/** Build an /alerts URL; defaults (inbox, unresolved) are left out. */
export function alertsHref(p: AlertsParams): string {
  const q = new URLSearchParams();
  if (p.tab && p.tab !== 'inbox') q.set('tab', p.tab);
  if (p.status && p.status !== 'UNRESOLVED') q.set('status', p.status.toLowerCase());
  if (p.kind) q.set('kind', p.kind.toLowerCase());
  if (p.severity) q.set('severity', p.severity.toLowerCase());
  if (p.cursor) q.set('cursor', p.cursor);
  if (p.alert) q.set('alert', p.alert);
  if (p.rule) q.set('rule', p.rule);
  if (p.destination) q.set('destination', p.destination);
  const qs = q.toString();
  return qs ? `/alerts?${qs}` : '/alerts';
}

/** "3600" → "1h", "900" → "15m", "86400" → "1d". */
export function windowLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
