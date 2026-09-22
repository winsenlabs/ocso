import { z } from 'zod';
import { checkConfig, httpsUrlProblems } from '../config-check.js';
import type { AlertDeliveryAdapter, AlertMessage } from '../contract.js';
import { postJson, redactSecrets, resultFromHttp, safeToken } from '../http.js';
import { renderAlert, truncate } from '../render.js';
import type { DeliveryAdapterDeps } from './deps.js';

const SlackConfig = z
  .object({
    /** Display only (the channel is fixed by the incoming webhook). */
    channelLabel: z.string().trim().max(80).optional(),
  })
  .strict();
export type SlackConfig = z.infer<typeof SlackConfig>;

/**
 * Slack incoming webhook. The webhook URL is the credential, so it lives in
 * the SecretStore and is never echoed in errors. Message uses Block Kit with
 * the severity as plain text (no emoji) plus a deep link back to OCSO.
 */
export function createSlackAdapter(deps: Pick<DeliveryAdapterDeps, 'fetch' | 'timeoutMs'>): AlertDeliveryAdapter<SlackConfig> {
  return {
    kind: 'SLACK',
    label: 'Slack',
    secret: { required: true, secretKind: 'WEBHOOK_SECRET', description: 'Slack incoming webhook URL' },
    validateConfig: (config) => checkConfig(SlackConfig, config),
    validateSecret: (secret) => httpsUrlProblems(secret, 'Slack webhook URL'),
    async deliver(message, _config, secret) {
      if (!secret) return { ok: false, retriable: false, error: 'webhook URL not configured' };
      const outcome = await postJson(deps.fetch, { url: secret, body: JSON.stringify(buildSlackPayload(message)), timeoutMs: deps.timeoutMs });
      // Slack answers errors with short tokens such as `channel_not_found` or `invalid_payload`.
      return resultFromHttp(outcome, (_status, text) => safeToken(redactSecrets(text, [secret])));
    },
  };
}

type MrkdwnText = { type: 'mrkdwn'; text: string };
type PlainText = { type: 'plain_text'; text: string };

export interface SlackPayload {
  text: string;
  blocks: Array<
    | { type: 'header'; text: PlainText }
    | { type: 'section'; text: MrkdwnText }
    | { type: 'section'; fields: MrkdwnText[] }
    | { type: 'context'; elements: MrkdwnText[] }
    | { type: 'actions'; elements: Array<{ type: 'button'; text: PlainText; url: string; action_id: string }> }
  >;
}

export function buildSlackPayload(message: AlertMessage): SlackPayload {
  const r = renderAlert(message);
  const blocks: SlackPayload['blocks'] = [
    { type: 'header', text: { type: 'plain_text', text: truncate(r.headline, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: truncate(escapeMrkdwn(r.body), 3000) } },
    {
      type: 'section',
      fields: r.fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: truncate(`*${f.label}*\n${escapeMrkdwn(f.value)}`, 2000) })),
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: escapeMrkdwn(r.footer) }] },
  ];
  if (r.link) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in OCSO' }, url: r.link, action_id: 'ocso_open_alert' }],
    });
  }
  return { text: truncate(r.summary, 3000), blocks };
}

/** Slack mrkdwn control characters (https://api.slack.com/reference/surfaces/formatting#escaping). */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
