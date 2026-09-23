import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';

/** WhatsApp Cloud API channel settings (non-secret, admin-editable). */

export const WHATSAPP_DEFAULT_GRAPH_VERSION = 'v26.0';
export const WHATSAPP_DEFAULT_GRAPH_BASE_URL = 'https://graph.facebook.com';
export const WHATSAPP_SECRET_KEYS = ['accessToken', 'appSecret', 'verifyToken'] as const;

const MIN_VERIFY_TOKEN_LENGTH = 16;
const metaId = z.string().regex(/^\d{1,32}$/, 'must be a numeric Meta id');

function isSecureOrLocal(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export const WhatsAppSettings = z.object({
  /** Default sending number; inbound `metadata.phone_number_id` overrides per conversation. */
  phoneNumberId: metaId,
  /** WABA id. Required for message templates; when set, webhook entries for other WABAs are ignored. */
  businessAccountId: metaId.optional().meta({
    title: 'WhatsApp Business Account id',
    description: 'WhatsApp Manager → Account tools → WABA id. Required to list, create and track message templates (needed to reach customers after 24 hours).',
  }),
  graphApiVersion: z
    .string()
    .regex(/^v\d{1,3}\.\d{1,2}$/, 'must look like v26.0')
    .default(WHATSAPP_DEFAULT_GRAPH_VERSION),
  /** Overridable for tests and proxies; https required except for localhost. */
  graphBaseUrl: z
    .url()
    .refine(isSecureOrLocal, 'must use https (http is allowed for localhost only)')
    .transform((value) => value.replace(/\/+$/, ''))
    .default(WHATSAPP_DEFAULT_GRAPH_BASE_URL),
  /** `link`: Meta downloads a short-lived signed URL. `upload`: bytes are uploaded to /media first. */
  outboundMediaMode: z.enum(['link', 'upload']).default('link'),
  mediaLinkTtlSeconds: z.number().int().min(60).max(86_400).default(900),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
  mediaDownloadTimeoutMs: z.number().int().min(1_000).max(300_000).default(60_000),
});
export type WhatsAppSettings = z.infer<typeof WhatsAppSettings>;

export interface WhatsAppSecrets {
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}

export interface ResolvedWhatsAppConfig {
  channelId: string;
  settings: WhatsAppSettings;
  secrets: WhatsAppSecrets;
}

function settingsProblems(settings: unknown): { problems: string[]; parsed: WhatsAppSettings | null } {
  const result = WhatsAppSettings.safeParse(settings ?? {});
  if (result.success) return { problems: [], parsed: result.data };
  const problems = result.error.issues.map((issue) => `settings.${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return { problems, parsed: null };
}

/** Secret problems; never echoes secret values. */
function secretProblems(secrets: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const key of WHATSAPP_SECRET_KEYS) {
    const value = secrets[key];
    if (!value || !value.trim()) problems.push(`secrets.${key}: required`);
    else if (/\s/.test(value)) problems.push(`secrets.${key}: must not contain whitespace`);
  }
  const verifyToken = secrets['verifyToken'];
  if (verifyToken && verifyToken.length < MIN_VERIFY_TOKEN_LENGTH) {
    problems.push(`secrets.verifyToken: must be at least ${MIN_VERIFY_TOKEN_LENGTH} characters`);
  }
  return problems;
}

export function validateWhatsAppConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  return [...settingsProblems(settings).problems, ...secretProblems(secrets)];
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedWhatsAppConfig>();

/** Parse and cache a channel's config; throws a typed validation error when unusable. */
export function resolveWhatsAppConfig(config: ChannelRuntimeConfig): ResolvedWhatsAppConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const allProblems = [...problems, ...secretProblems(config.secrets)];
  if (!parsed || allProblems.length) throw channelConfigError(allProblems);
  const value: ResolvedWhatsAppConfig = {
    channelId: config.id,
    settings: parsed,
    secrets: {
      accessToken: config.secrets['accessToken'] ?? '',
      appSecret: config.secrets['appSecret'] ?? '',
      verifyToken: config.secrets['verifyToken'] ?? '',
    },
  };
  resolved.set(config, value);
  return value;
}

/** All secret values of a config, for redaction of provider text. */
export function secretValues(config: ResolvedWhatsAppConfig): string[] {
  return [config.secrets.accessToken, config.secrets.appSecret, config.secrets.verifyToken];
}
