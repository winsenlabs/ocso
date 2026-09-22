import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';

/** OCSO web chat channel settings and secrets. */

const MIN_SECRET_LENGTH = 32;
const DAY = 86_400;

export const WebChatSettings = z.object({
  /** Lifetime of OCSO-issued visitor tokens (anonymous continuity across reloads). */
  visitorTokenTtlSeconds: z
    .number()
    .int()
    .min(300)
    .max(90 * DAY)
    .default(30 * DAY),
  /** When set, host-app JWTs must carry this `iss`. */
  hostJwtIssuer: z.string().min(1).max(256).optional(),
  /** When set, host-app JWTs must carry this `aud` (string or array member). */
  hostJwtAudience: z.string().min(1).max(256).optional(),
  maxAttachmentsPerMessage: z.number().int().min(0).max(10).default(5),
});
export type WebChatSettings = z.infer<typeof WebChatSettings>;

export interface ResolvedWebChatConfig {
  channelId: string;
  settings: WebChatSettings;
  visitorTokenSecret: string;
  /** Present only when authenticated (host-app) customers are enabled. */
  hostJwtSecret: string | undefined;
}

function settingsProblems(settings: unknown): { problems: string[]; parsed: WebChatSettings | null } {
  const result = WebChatSettings.safeParse(settings ?? {});
  if (result.success) return { problems: [], parsed: result.data };
  return {
    problems: result.error.issues.map((issue) => `settings.${issue.path.join('.') || '(root)'}: ${issue.message}`),
    parsed: null,
  };
}

/** Never echoes secret values. */
function secretProblems(secrets: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const visitor = secrets['visitorTokenSecret'];
  if (!visitor) problems.push('secrets.visitorTokenSecret: required');
  else if (visitor.length < MIN_SECRET_LENGTH) {
    problems.push(`secrets.visitorTokenSecret: must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const host = secrets['hostJwtSecret'];
  if (host !== undefined && host !== '' && host.length < MIN_SECRET_LENGTH) {
    problems.push(`secrets.hostJwtSecret: must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return problems;
}

export function validateWebChatConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  return [...settingsProblems(settings).problems, ...secretProblems(secrets)];
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedWebChatConfig>();

export function resolveWebChatConfig(config: ChannelRuntimeConfig): ResolvedWebChatConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const allProblems = [...problems, ...secretProblems(config.secrets)];
  if (!parsed || allProblems.length) throw channelConfigError(allProblems);
  const value: ResolvedWebChatConfig = {
    channelId: config.id,
    settings: parsed,
    visitorTokenSecret: config.secrets['visitorTokenSecret'] ?? '',
    hostJwtSecret: config.secrets['hostJwtSecret'] || undefined,
  };
  resolved.set(config, value);
  return value;
}
