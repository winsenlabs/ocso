import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';

/** Slack channel settings (non-secret, admin-editable) and secrets. */

export const SLACK_DEFAULT_API_BASE_URL = 'https://slack.com/api';
export const SLACK_SECRET_KEYS = ['botToken', 'signingSecret'] as const;

export const SLACK_RESPOND_TO = ['dm', 'mentions', 'dm_and_mentions'] as const;
export type SlackRespondTo = (typeof SLACK_RESPOND_TO)[number];

/**
 * Public (C…), private (G…) channel ids; DMs (D…) are always answered when DMs are on. Real ids always hold a
 * digit, which keeps a channel *name* such as "general" from passing as an id.
 */
const CHANNEL_ID = /^[CG](?=[A-Z0-9]*\d)[A-Z0-9]{6,30}$/;

function isSecureOrLocal(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export const SlackSettings = z.object({
  respondTo: z
    .enum(SLACK_RESPOND_TO)
    .default('dm_and_mentions')
    .meta({ title: 'Respond to', description: 'Direct messages to the app, @mentions of the app in channels, or both.' }),
  replyInThread: z
    .boolean()
    .default(true)
    .meta({ title: 'Reply in thread', description: 'Answer an @mention in a thread under it (on), or in the channel itself (off). Messages already in a thread are always answered there.' }),
  allowedChannelIds: z
    .array(z.string().trim().toUpperCase().regex(CHANNEL_ID, 'must be a Slack channel id such as C0123456789'))
    .max(200)
    .default([])
    .meta({ title: 'Allowed channels', description: 'Channel ids (C…/G…) where @mentions are answered. Empty = every channel the app is in. DMs are not affected.' }),
  apiBaseUrl: z
    .url()
    .refine(isSecureOrLocal, 'must use https (http is allowed for localhost only)')
    .transform((value) => value.replace(/\/+$/, ''))
    .default(SLACK_DEFAULT_API_BASE_URL)
    .meta({ title: 'API base URL', description: 'Override only for tests or an egress proxy.' }),
  requestTimeoutMs: z.number().int().min(1_000).max(60_000).default(10_000).meta({ title: 'Request timeout (ms)', description: 'How long one Slack API call may take.' }),
  /** 429 retries inside one send (each waits Retry-After); longer waits go back to the outbox backoff. */
  rateLimitRetries: z.number().int().min(0).max(5).default(2).meta({ title: 'Rate-limit retries', description: 'Retries after HTTP 429 inside one send, each after Slack’s Retry-After.' }),
  /** Longest Retry-After (seconds) a send waits in place before handing the retry to the outbox. */
  maxRetryAfterSeconds: z.number().int().min(1).max(60).default(10).meta({ title: 'Longest in-place wait (s)', description: 'A longer Retry-After goes back to the outbox backoff.' }),
});
export type SlackSettings = z.infer<typeof SlackSettings>;

export interface SlackSecrets {
  /** Bot User OAuth Token (`xoxb-…`): sends messages, reads users. */
  botToken: string;
  /** Signing secret: verifies every request Slack posts to the webhook. */
  signingSecret: string;
}

export interface ResolvedSlackConfig {
  channelId: string;
  settings: SlackSettings;
  secrets: SlackSecrets;
  webhookUrl?: string | undefined;
}

const BOT_TOKEN = /^xoxb-[A-Za-z0-9-]{10,250}$/;
const SIGNING_SECRET = /^[A-Za-z0-9]{16,128}$/;

function settingsProblems(settings: unknown): { problems: string[]; parsed: SlackSettings | null } {
  const result = SlackSettings.safeParse(settings ?? {});
  if (result.success) return { problems: [], parsed: result.data };
  return { problems: result.error.issues.map((issue) => `settings.${issue.path.join('.') || '(root)'}: ${issue.message}`), parsed: null };
}

/** Secret problems; never echoes secret values. */
function secretProblems(secrets: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const token = secrets['botToken']?.trim();
  if (!token) problems.push('secrets.botToken: required');
  else if (token.startsWith('xoxp-') || token.startsWith('xoxe')) problems.push('secrets.botToken: use the Bot User OAuth Token (xoxb-…), not a user or refresh token');
  else if (!BOT_TOKEN.test(token)) problems.push('secrets.botToken: must be a Bot User OAuth Token (xoxb-…)');
  const signing = secrets['signingSecret']?.trim();
  if (!signing) problems.push('secrets.signingSecret: required');
  else if (!SIGNING_SECRET.test(signing)) problems.push('secrets.signingSecret: must be the app’s Signing Secret (Basic Information → App Credentials)');
  return problems;
}

export function validateSlackConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  return [...settingsProblems(settings).problems, ...secretProblems(secrets)];
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedSlackConfig>();

/** Parse and cache a channel's config; throws a typed validation error when unusable. */
export function resolveSlackConfig(config: ChannelRuntimeConfig): ResolvedSlackConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const all = [...problems, ...secretProblems(config.secrets)];
  if (!parsed || all.length) throw channelConfigError(all);
  const value: ResolvedSlackConfig = {
    channelId: config.id,
    settings: parsed,
    secrets: { botToken: (config.secrets['botToken'] ?? '').trim(), signingSecret: (config.secrets['signingSecret'] ?? '').trim() },
    webhookUrl: config.webhookUrl,
  };
  resolved.set(config, value);
  return value;
}

/** Settings only (defaults applied), for parsing inbound events when secrets are not needed. */
export function slackSettingsOf(config: ChannelRuntimeConfig): SlackSettings {
  const parsed = SlackSettings.safeParse(config.settings ?? {});
  return parsed.success ? parsed.data : SlackSettings.parse({});
}

export function slackSecretValues(config: ResolvedSlackConfig): string[] {
  return [config.secrets.botToken, config.secrets.signingSecret].filter(Boolean);
}
