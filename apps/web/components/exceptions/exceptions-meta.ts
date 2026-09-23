import type { StatusTone } from '@/components/ui/status-chip';

/**
 * Presentation of the exception report (PM/research/11 §7). Pure and client-safe.
 * The API sends each item's own link when it has one; otherwise a configuration
 * object links to the screen that manages its kind.
 */

export type ExceptionsView = 'live' | 'reports';

export const SEVERITY_TONE: Record<string, StatusTone> = { critical: 'danger', high: 'danger', medium: 'warn', low: 'muted' };

const KIND_SCREENS: Record<string, (id: string) => string> = {
  agent: (id) => `/agents/${id}`,
  router: (id) => `/routers/${id}`,
  queue: () => '/queues',
  sla_policy: () => '/sla',
  channel: () => '/connections?tab=channels',
  message_template: () => '/templates',
  model_provider: () => '/connections?tab=providers',
  model_profile: () => '/connections?tab=providers',
  mcp_connection: () => '/connections?tab=mcp',
  webhook_subscription: () => '/connections?tab=webhooks',
  notification_destination: () => '/alerts',
  alert_rule: () => '/alerts',
  user: (id) => `/team?user=${id}`,
  permission_change: (id) => `/team?user=${id}`,
};

export function itemHref(item: { href: string | null; objectKind: string; objectId: string | null }): string | null {
  if (item.href) return item.href;
  const screen = KIND_SCREENS[item.objectKind];
  return screen && item.objectId ? screen(item.objectId) : null;
}

export function parseView(raw: Record<string, string | string[] | undefined>): ExceptionsView {
  const v = Array.isArray(raw['view']) ? raw['view'][0] : raw['view'];
  return v === 'reports' ? 'reports' : 'live';
}

/** "14 Sep – 20 Sep 2026" in the deployment zone; the end is exclusive (Monday 00:00), so show the day before. */
export function periodLabel(start: string, end: string, timeZone: string): string {
  const day = (d: Date, year: boolean) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone });
  const last = new Date(new Date(end).getTime() - 1);
  return `${day(new Date(start), false)} – ${day(last, true)}`;
}

export const VERIFICATION_TEXT: Record<string, { tone: StatusTone; text: string }> = {
  VALID: { tone: 'good', text: 'signature verifies' },
  INVALID: { tone: 'danger', text: 'signature does not verify' },
  CONTENT_CHANGED: { tone: 'danger', text: 'content changed since signing' },
  UNKNOWN_KEY: { tone: 'warn', text: 'signed with a key this server does not trust' },
};

/** What a signer acknowledges (the API's attestation flags, ADR-033). */
export const ATTESTATION_TEXT: Record<string, { short: string; long: string }> = {
  self_attested: {
    short: 'self-attested',
    long: 'I am named in this report’s critical or high items, or my own access was self-approved: this sign-off is self-attested.',
  },
  failed_checks: { short: 'failed checks', long: 'Some checks failed and report nothing: I sign knowing they were not run.' },
  truncated: { short: 'truncated', long: 'Some sections list fewer items than they counted.' },
  incomplete_data: { short: 'incomplete data', long: 'Some checks cover a period older than the history they read: their sections may be incomplete.' },
};

export const KEY_TRUST_TEXT: Record<string, { tone: StatusTone; text: string } | undefined> = {
  CURRENT: undefined,
  RETIRED: { tone: 'muted', text: 'signed with a retired key' },
  UNKNOWN: { tone: 'warn', text: 'signing key not known to this server' },
};

export const SIGN_BLOCKED_TEXT: Record<string, string | undefined> = {
  signing_key_unavailable: 'Signing key not configured on this server: set the audit signing key to sign reports.',
};
