import type { AlertEvent, AlertKind, AlertMessage } from './contract.js';
import { formatCount } from './format.js';
import { SEVERITY_LABELS } from './severity.js';

export const EVENT_LABELS: Readonly<Record<AlertEvent, string>> = {
  OPENED: 'Opened',
  ACKNOWLEDGED: 'Acknowledged',
  RESOLVED: 'Resolved',
  REMINDER: 'Still open',
};

export const KIND_LABELS: Readonly<Record<AlertKind, string>> = { TECHNICAL: 'Technical', BUSINESS: 'Business' };

export interface RenderedField {
  label: string;
  value: string;
}

/** Channel-neutral text rendering shared by the email, Slack and Teams adapters. */
export interface RenderedAlert {
  /** "[CRITICAL] Provider error rate above 5% · AWS Bedrock" — severity as text, no emoji. */
  headline: string;
  /** Email subject. */
  subject: string;
  /** One-line notification text (chat fallback / preview). */
  summary: string;
  body: string;
  fields: RenderedField[];
  link: string | null;
  footer: string;
}

/** Severity tag, or RESOLVED once the alert is closed. */
export function severityTag(message: Pick<AlertMessage, 'event' | 'severity'>): string {
  return message.event === 'RESOLVED' ? 'RESOLVED' : message.severity;
}

export function renderAlert(message: AlertMessage): RenderedAlert {
  const tag = severityTag(message);
  const fields: RenderedField[] = [
    { label: 'Severity', value: SEVERITY_LABELS[message.severity] },
    { label: 'Kind', value: KIND_LABELS[message.kind] },
    { label: 'Source', value: message.source },
    ...(message.value ? [{ label: 'Value', value: message.value }] : []),
    { label: 'State', value: EVENT_LABELS[message.event] },
    { label: 'Opened', value: message.openedAt },
    { label: 'Occurrences', value: formatCount(message.occurrences) },
    ...(message.ruleName ? [{ label: 'Rule', value: message.ruleName }] : []),
  ];
  const body = message.resolution && message.event === 'RESOLVED' ? `${message.body}\nResolution: ${message.resolution}` : message.body;
  return {
    headline: `[${tag}] ${message.title}`,
    subject: `[OCSO ${tag}] ${message.title}`,
    summary: `${EVENT_LABELS[message.event]}: [${tag}] ${message.title}${message.value ? ` (${message.value})` : ''}`,
    body,
    fields,
    link: message.link,
    footer: `OCSO${message.deployment ? ` · ${message.deployment}` : ''} · alert ${message.alertId}`,
  };
}

/** Deep link to an alert in the OCSO UI; null when no public URL is configured. */
export function alertLink(baseUrl: string | null | undefined, alertId: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}/alerts/${encodeURIComponent(alertId)}`;
}

/** Truncate to a provider field limit, marking the cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
