import { z } from 'zod';
import type { ChannelRuntimeConfig } from '../contract/types.js';
import { channelConfigError } from '../common/errors.js';
import { SECRET_KEY_PATTERN, WebChatAuthSettings, WebChatContextSettings, WebChatToolIdentity } from './auth-settings.js';
import { WebChatOrigin } from './origins.js';

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
  /**
   * Host-site origins that may embed the widget (CSP frame-ancestors, widget
   * postMessage checks, API Origin check). Empty = any site may embed it.
   */
  allowedOrigins: z.array(WebChatOrigin).max(50).default([]),
  /** Accept audio attachments (mp3/m4a/ogg) from customers; off by default. */
  audioAttachments: z.boolean().default(false),
  /** Customer-facing look of the widget; every field is optional. */
  branding: z
    .object({
      /** Header title; defaults to the channel's virtual agent name. */
      title: z.string().trim().min(1).max(60).optional(),
      subtitle: z.string().trim().max(120).optional(),
      /** Shown above the composer before the first message; never stored as a message. */
      greeting: z.string().trim().max(500).optional(),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour').optional(),
      theme: z.enum(['light', 'dark', 'auto']).default('light'),
      position: z.enum(['right', 'left']).default('right'),
      launcherLabel: z.string().trim().max(40).optional(),
    })
    .default({ theme: 'light', position: 'right' }),
  /** Who may open a chat session and how signed-in users are verified. */
  auth: WebChatAuthSettings.default({ mode: 'anonymous', allowNativeApps: false }),
  /** Key/values the site may pass with a session (shown to the agent, labelled by who vouched for them). */
  context: WebChatContextSettings.default({ allow: [], maxBytes: 2_048 }),
  /** Identity agent tool calls carry: OCSO-signed claims only, or also the verified user token (to opted-in connections). */
  toolIdentity: WebChatToolIdentity.default('ocso'),
});
export type WebChatSettings = z.infer<typeof WebChatSettings>;

export interface ResolvedWebChatConfig {
  channelId: string;
  settings: WebChatSettings;
  visitorTokenSecret: string;
  /** Present only when authenticated (host-app) customers are enabled. */
  hostJwtSecret: string | undefined;
  /** Server-side secret key (`sk_…`) the site's backend mints session passes with; absent on older channels. */
  secretKey: string | undefined;
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
  const secretKey = secrets['secretKey'];
  if (secretKey !== undefined && secretKey !== '' && !SECRET_KEY_PATTERN.test(secretKey)) {
    problems.push('secrets.secretKey: must be sk_ followed by at least 32 url-safe characters');
  }
  return problems;
}

/** Rules across settings and secrets (never echoes secret values). */
function accessProblems(settings: WebChatSettings, secrets: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const { mode, userToken } = settings.auth;
  const hs256 = Boolean(secrets['hostJwtSecret']);
  if (mode === 'client' && !secrets['secretKey']) problems.push('secrets.secretKey: required when the auth mode is client');
  if (userToken?.verify === 'hs256' && !hs256) problems.push('secrets.hostJwtSecret: required to verify user tokens with HS256');
  const canVerifyUsers = userToken ? userToken.verify === 'jwks' || hs256 : hs256;
  if (mode === 'user' && !canVerifyUsers) problems.push('settings.auth.userToken: signed-in users need a JWKS URL or the host identity secret (HS256)');
  if (settings.toolIdentity === 'passthrough' && !canVerifyUsers) {
    problems.push('settings.toolIdentity: passthrough needs verified user tokens (a JWKS URL or the host identity secret)');
  }
  if (settings.toolIdentity === 'passthrough' && !secrets['secretKey']) problems.push('secrets.secretKey: required to keep user tokens for passthrough');
  return problems;
}

export function validateWebChatConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
  const { problems, parsed } = settingsProblems(settings);
  return [...problems, ...secretProblems(secrets), ...(parsed ? accessProblems(parsed, secrets) : [])];
}

const resolved = new WeakMap<ChannelRuntimeConfig, ResolvedWebChatConfig>();

export function resolveWebChatConfig(config: ChannelRuntimeConfig): ResolvedWebChatConfig {
  const cached = resolved.get(config);
  if (cached) return cached;
  const { problems, parsed } = settingsProblems(config.settings);
  const allProblems = [...problems, ...secretProblems(config.secrets), ...(parsed ? accessProblems(parsed, config.secrets) : [])];
  if (!parsed || allProblems.length) throw channelConfigError(allProblems);
  const value: ResolvedWebChatConfig = {
    channelId: config.id,
    settings: parsed,
    visitorTokenSecret: config.secrets['visitorTokenSecret'] ?? '',
    hostJwtSecret: config.secrets['hostJwtSecret'] || undefined,
    secretKey: config.secrets['secretKey'] || undefined,
  };
  resolved.set(config, value);
  return value;
}
