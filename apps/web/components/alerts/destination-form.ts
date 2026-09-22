/**
 * Notification destination config per kind (packages/alerts adapters). Pure
 * and client-safe. Secrets (webhook URLs, routing keys, SMTP passwords) are
 * entered once, stored in the SecretStore and never shown again; configs hold
 * only non-secret settings. The API validates both.
 */

export type ConfigFieldKind = 'text' | 'number' | 'list' | 'boolean' | 'select';

export interface ConfigField {
  name: string;
  label: string;
  kind: ConfigFieldKind;
  hint?: string;
  options?: string[];
  optional?: boolean;
}

export interface KindSpec {
  label: string;
  fields: ConfigField[];
  /** null = this kind never takes a secret. */
  secret: { label: string; required: boolean } | null;
  receives: string;
}

export const DESTINATION_SPECS: Record<string, KindSpec> = {
  IN_APP: { label: 'In-app', fields: [], secret: null, receives: 'opened alerts, in the OCSO inbox' },
  EMAIL: {
    label: 'Email (SMTP)',
    fields: [
      { name: 'host', label: 'SMTP host', kind: 'text' },
      { name: 'port', label: 'Port', kind: 'number', hint: '587 STARTTLS · 465 implicit TLS' },
      { name: 'from', label: 'From address', kind: 'text' },
      { name: 'to', label: 'Recipients', kind: 'list', hint: 'comma separated' },
      { name: 'username', label: 'SMTP user', kind: 'text', optional: true, hint: 'defaults to the from address' },
      { name: 'requireTLS', label: 'Require TLS', kind: 'boolean' },
    ],
    secret: { label: 'SMTP password', required: false },
    receives: 'opened, resolved and reminders',
  },
  SLACK: {
    label: 'Slack',
    fields: [{ name: 'channelLabel', label: 'Channel label', kind: 'text', optional: true, hint: 'display only; the webhook fixes the channel' }],
    secret: { label: 'Incoming webhook URL', required: true },
    receives: 'opened, resolved and reminders',
  },
  TEAMS: {
    label: 'Microsoft Teams',
    fields: [{ name: 'channelLabel', label: 'Channel label', kind: 'text', optional: true, hint: 'display only' }],
    secret: { label: 'Workflows or incoming webhook URL', required: true },
    receives: 'opened, resolved and reminders',
  },
  WEBHOOK: {
    label: 'Webhook (HMAC-signed)',
    fields: [{ name: 'url', label: 'Endpoint URL', kind: 'text', hint: 'https only' }],
    secret: { label: 'Signing secret', required: true },
    receives: 'every lifecycle change',
  },
  PAGERDUTY: {
    label: 'PagerDuty',
    fields: [
      { name: 'region', label: 'Region', kind: 'select', options: ['US', 'EU'] },
      { name: 'component', label: 'Component', kind: 'text', optional: true },
      { name: 'group', label: 'Group', kind: 'text', optional: true },
    ],
    secret: { label: 'Events API v2 routing key', required: true },
    receives: 'every lifecycle change (trigger, acknowledge, resolve)',
  },
};

export function specOf(kind: string): KindSpec {
  return DESTINATION_SPECS[kind] ?? { label: kind, fields: [], secret: null, receives: '' };
}

/** Stored config → form strings. */
export function configText(kind: string, config: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of specOf(kind).fields) {
    const v = config?.[f.name];
    if (f.kind === 'list') out[f.name] = Array.isArray(v) ? v.join(', ') : '';
    else if (f.kind === 'boolean') out[f.name] = v === false ? 'false' : 'true';
    else if (f.kind === 'select') out[f.name] = typeof v === 'string' ? v : (f.options?.[0] ?? '');
    else out[f.name] = v === undefined || v === null ? '' : String(v);
  }
  return out;
}

/** Form strings → config: blanks are omitted (the adapter applies defaults), numbers and lists converted. */
export function buildConfig(kind: string, text: Record<string, string>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of specOf(kind).fields) {
    const raw = (text[f.name] ?? '').trim();
    if (f.kind === 'boolean') {
      config[f.name] = raw !== 'false';
      continue;
    }
    if (raw === '') continue;
    if (f.kind === 'number') config[f.name] = Number(raw);
    else if (f.kind === 'list')
      config[f.name] = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else config[f.name] = raw;
  }
  return config;
}

/** One-line summary of a destination's non-secret config for the table. */
export function configSummary(kind: string, config: Record<string, unknown> | null): string {
  if (!config) return '—';
  switch (kind) {
    case 'EMAIL':
      return `${Array.isArray(config['to']) ? config['to'].join(', ') : ''} via ${String(config['host'] ?? '')}`;
    case 'WEBHOOK':
      return String(config['url'] ?? '');
    case 'SLACK':
    case 'TEAMS':
      return typeof config['channelLabel'] === 'string' ? config['channelLabel'] : 'webhook stored as a secret';
    case 'PAGERDUTY':
      return `region ${String(config['region'] ?? 'US')}`;
    case 'IN_APP':
      return 'OCSO inbox';
    default:
      return '';
  }
}
