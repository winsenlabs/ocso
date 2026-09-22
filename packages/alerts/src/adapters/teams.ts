import { z } from 'zod';
import { checkConfig, httpsUrlProblems } from '../config-check.js';
import type { AlertDeliveryAdapter, AlertMessage, AlertSeverity } from '../contract.js';
import { postJson, redactSecrets, resultFromHttp, safeToken } from '../http.js';
import { renderAlert, truncate } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';

const TeamsConfig = z
  .object({
    channelLabel: z.string().trim().max(80).optional(),
  })
  .strict();
export type TeamsConfig = z.infer<typeof TeamsConfig>;

/** Adaptive Card text colours by severity (resolved alerts are always "Good"). */
const SEVERITY_COLOR: Readonly<Record<AlertSeverity, 'Attention' | 'Warning' | 'Default'>> = {
  CRITICAL: 'Attention',
  WARNING: 'Warning',
  INFO: 'Default',
};

/**
 * Microsoft Teams via a Workflows (Power Automate) webhook or legacy incoming
 * webhook. Both accept a `message` with an Adaptive Card attachment. The URL
 * is the credential and lives in the SecretStore.
 */
export function createTeamsAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs'>): AlertDeliveryAdapter<TeamsConfig> {
  return {
    kind: 'TEAMS',
    label: 'Microsoft Teams',
    secret: { required: true, secretKind: 'WEBHOOK_SECRET', description: 'Teams Workflows or incoming webhook URL' },
    validateConfig: (config) => checkConfig(TeamsConfig, config),
    validateSecret: (secret) => httpsUrlProblems(secret, 'Teams webhook URL'),
    async deliver(message, _config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'webhook URL not configured' };
      const outcome = await postJson(deps.fetch, { url: secret, body: JSON.stringify(buildTeamsPayload(message)), timeoutMs: deps.timeoutMs });
      return resultFromHttp(outcome, (_status, text) => safeToken(redactSecrets(text, [secret])));
    },
  };
}

export function buildTeamsPayload(message: AlertMessage): Record<string, unknown> {
  const r = renderAlert(message);
  const color = message.event === 'RESOLVED' ? 'Good' : SEVERITY_COLOR[message.severity];
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body: [
      { type: 'TextBlock', text: truncate(r.headline, 300), weight: 'Bolder', size: 'Medium', color, wrap: true },
      { type: 'TextBlock', text: truncate(r.body, 3000), wrap: true },
      { type: 'FactSet', facts: r.fields.map((f) => ({ title: f.label, value: truncate(f.value, 500) })) },
      { type: 'TextBlock', text: r.footer, isSubtle: true, size: 'Small', wrap: true },
    ],
    actions: r.link ? [{ type: 'Action.OpenUrl', title: 'Open in OCSO', url: r.link }] : [],
  };
  return {
    type: 'message',
    summary: truncate(r.summary, 250),
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
  };
}
