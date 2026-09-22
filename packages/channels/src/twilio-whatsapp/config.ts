import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';
import { toWhatsAppAddress } from './identity.js';

/** Twilio WhatsApp channel settings (non-secret, admin-editable). PM/research/06. */

export const TWILIO_DEFAULT_API_BASE_URL = 'https://api.twilio.com';
export const TWILIO_SECRET_KEYS = ['authToken', 'apiKeySecret'] as const;

const sid = (prefix: string, what: string) =>
  z.string().trim().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`), `must be a Twilio ${what} (${prefix} followed by 32 hex characters)`);

function isSecureOrLocal(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export const TwilioWhatsAppSettings = z
  .object({
    accountSid: sid('AC', 'Account SID').meta({ title: 'Account SID', description: 'Twilio Console → Account info (starts with AC).' }),
    from: z
      .string()
      .trim()
      .regex(/^(?:whatsapp:)?\+[1-9]\d{6,14}$/, 'must be a WhatsApp sender such as whatsapp:+14155238886')
      .transform(toWhatsAppAddress)
      .optional()
      .meta({ title: 'WhatsApp sender', description: 'Your Twilio WhatsApp sender, e.g. whatsapp:+14155238886. Leave empty when sending through a Messaging Service.' }),
    messagingServiceSid: sid('MG', 'Messaging Service SID')
      .optional()
      .meta({ title: 'Messaging Service SID', description: 'Send through a Messaging Service (MG…) whose sender pool holds the WhatsApp sender, instead of a fixed sender.' }),
    apiKeySid: sid('SK', 'API key SID')
      .optional()
      .meta({ title: 'API key SID', description: 'Optional: call the REST API with an API key (SK…) and its secret instead of the auth token.' }),
    statusCallback: z
      .boolean()
      .default(true)
      .meta({ title: 'Request delivery statuses', description: "Ask Twilio to post each message's delivery status to this channel's webhook URL (needs an https public URL)." }),
    apiBaseUrl: z
      .url()
      .refine(isSecureOrLocal, 'must use https (http is allowed for localhost only)')
      .transform((value) => value.replace(/\/+$/, ''))
      .default(TWILIO_DEFAULT_API_BASE_URL)
      .meta({ title: 'API base URL', description: 'Override only for tests or an egress proxy.' }),
    mediaLinkTtlSeconds: z.number().int().min(60).max(86_400).default(900),
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    mediaDownloadTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.from) === Boolean(value.messagingServiceSid)) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'set either a WhatsApp sender or a Messaging Service SID (exactly one)' });
    }
  });
export type TwilioWhatsAppSettings = z.infer<typeof TwilioWhatsAppSettings>;

export interface TwilioWhatsAppSecrets {
  /** Signs every webhook (X-Twilio-Signature); also the REST credential unless an API key is set. */
  authToken: string;
  apiKeySecret?: string | undefined;
}

export interface ResolvedTwilioConfig {
  channelId: string;
  settings: TwilioWhatsAppSettings;
  secrets: TwilioWhatsAppSecrets;
  /** Public webhook URL, used as the per-message StatusCallback. */
  webhookUrl?: string | undefined;
}

function settingsProblems(settings: unknown): { problems: string[]; parsed: TwilioWhatsAppSettings | null } {
  const result = TwilioWhatsAppSettings.safeParse(settings ?? {});
  if (result.success) return { problems: [], parsed: result.data };
  const problems = result.error.issues.map((issue) => `settings.${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return { problems, parsed: null };
}

/** Secret problems; never echoes secret values. */
function secretProblems(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const check = (key: string, required: boolean) => {
    const value = secrets[key];
    if (!value?.trim()) {
      if (required) problems.push(`secrets.${key}: required`);
    } else if (/\s/.test(value)) problems.push(`secrets.${key}: must not contain whitespace`);
    else if (value.length < 16) problems.push(`secrets.${key}: looks too short`);
  };
  check('authToken', true);
  const usesApiKey = typeof settings === 'object' && settings !== null && Boolean((settings as Record<string, unknown>)['apiKeySid']);
  check('apiKeySecret', usesApiKey);
  return problems;
}

export function validateTwilioWhatsAppConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  return [...settingsProblems(settings).problems, ...secretProblems(settings, secrets)];
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedTwilioConfig>();

/** Parse and cache a channel's config; throws a typed validation error when unusable. */
export function resolveTwilioConfig(config: ChannelRuntimeConfig): ResolvedTwilioConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const allProblems = [...problems, ...secretProblems(config.settings, config.secrets)];
  if (!parsed || allProblems.length) throw channelConfigError(allProblems);
  const value: ResolvedTwilioConfig = {
    channelId: config.id,
    settings: parsed,
    secrets: { authToken: config.secrets['authToken'] ?? '', apiKeySecret: config.secrets['apiKeySecret'] },
    webhookUrl: config.webhookUrl,
  };
  resolved.set(config, value);
  return value;
}

/** All secret values of a config, for redaction of provider text. */
export function twilioSecretValues(config: ResolvedTwilioConfig): string[] {
  return [config.secrets.authToken, config.secrets.apiKeySecret ?? ''].filter(Boolean);
}
