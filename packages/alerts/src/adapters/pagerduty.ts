import { z } from 'zod';
import { checkConfig } from '../config-check.js';
import type { AlertDeliveryAdapter, AlertEvent, AlertMessage, AlertSeverity } from '../contract.js';
import { postJson, redactSecrets, resultFromHttp } from '../http.js';
import { renderAlert, truncate } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';

export const PAGERDUTY_ENDPOINTS = {
  US: 'https://events.pagerduty.com/v2/enqueue',
  EU: 'https://events.eu.pagerduty.com/v2/enqueue',
} as const;

const PagerDutyConfig = z
  .object({
    region: z.enum(['US', 'EU']).default('US'),
    /** Optional PagerDuty `component` / `group` overrides. */
    component: z.string().trim().max(120).optional(),
    group: z.string().trim().max(120).optional(),
  })
  .strict();
export type PagerDutyConfig = z.output<typeof PagerDutyConfig>;

export const PAGERDUTY_SEVERITY: Readonly<Record<AlertSeverity, 'critical' | 'warning' | 'info'>> = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

export const PAGERDUTY_ACTION: Readonly<Record<AlertEvent, 'trigger' | 'acknowledge' | 'resolve'>> = {
  OPENED: 'trigger',
  REMINDER: 'trigger',
  ACKNOWLEDGED: 'acknowledge',
  RESOLVED: 'resolve',
};

/**
 * PagerDuty Events API v2. The alert fingerprint is the `dedup_key`, so a
 * re-trigger updates the same incident and ack/resolve in OCSO mirror into
 * PagerDuty. The integration (routing) key is the secret.
 */
export function createPagerDutyAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs'>): AlertDeliveryAdapter<PagerDutyConfig> {
  return {
    kind: 'PAGERDUTY',
    label: 'PagerDuty',
    secret: { required: true, secretKind: 'API_KEY', description: 'Events API v2 integration (routing) key' },
    validateConfig: (config) => checkConfig(PagerDutyConfig, config),
    validateSecret: (secret) => (/^[A-Za-z0-9]{20,64}$/.test(secret) ? [] : ['routing key must be 20–64 letters or digits']),
    async deliver(message, config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'routing key not configured' };
      const outcome = await postJson(deps.fetch, {
        url: PAGERDUTY_ENDPOINTS[config.region],
        body: JSON.stringify(buildPagerDutyEvent(message, config, secret)),
        timeoutMs: deps.timeoutMs,
      });
      const result = resultFromHttp(outcome, (_status, text) => pagerDutyErrors(redactSecrets(text, [secret])));
      if (result.ok && outcome.kind === 'response') return { ...result, externalId: dedupKeyFrom(outcome.text) ?? message.fingerprint };
      return result;
    },
  };
}

export function buildPagerDutyEvent(message: AlertMessage, config: PagerDutyConfig, routingKey: string): Record<string, unknown> {
  const action = PAGERDUTY_ACTION[message.event];
  const base = { routing_key: routingKey, event_action: action, dedup_key: message.fingerprint };
  if (action !== 'trigger') return base;
  const r = renderAlert(message);
  return {
    ...base,
    payload: {
      summary: truncate(`${message.title}${message.value ? ` (${message.value})` : ''}`, 1024),
      source: truncate(message.source || 'ocso', 255),
      severity: PAGERDUTY_SEVERITY[message.severity],
      timestamp: message.lastSeenAt,
      component: config.component ?? message.source,
      group: config.group ?? message.kind.toLowerCase(),
      class: message.condition ?? 'alert',
      custom_details: {
        body: message.body,
        value: message.value,
        rule: message.ruleName,
        occurrences: message.occurrences,
        alertId: message.alertId,
        deployment: message.deployment,
        context: message.context,
      },
    },
    client: 'OCSO',
    ...(r.link ? { client_url: r.link, links: [{ href: r.link, text: 'Open in OCSO' }] } : {}),
  };
}

function pagerDutyErrors(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { message?: unknown; errors?: unknown };
    const errors = Array.isArray(body.errors) ? body.errors.filter((e): e is string => typeof e === 'string') : [];
    const message = typeof body.message === 'string' ? body.message : '';
    const joined = [message, ...errors].filter(Boolean).join('; ');
    return joined ? joined.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function dedupKeyFrom(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { dedup_key?: unknown };
    return typeof body.dedup_key === 'string' ? body.dedup_key : undefined;
  } catch {
    return undefined;
  }
}
