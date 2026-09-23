import { z } from 'zod';

/**
 * Boundary schemas for the MCP connection manager (build rule §19). The API
 * validates with these and services re-parse, so the internal agent and
 * scripts get the same guarantees.
 */

/** Lower-case slug; `_` is excluded so model-facing names (`<conn>__<tool>`) stay unambiguous. */
export const CONNECTION_NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

const McpUrl = z
  .string()
  .trim()
  .max(2_048)
  .transform((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' });
      return z.NEVER;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') ctx.addIssue({ code: 'custom', message: 'must use https (or http for allowlisted internal hosts)' });
    if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'must not contain credentials' });
    if (url.hash) ctx.addIssue({ code: 'custom', message: 'must not contain a fragment' });
    return url.href;
  });

export const CreateConnectionInput = z.object({
  name: z.string().trim().regex(CONNECTION_NAME, 'lower-case letters, digits and dashes (2–40 chars)'),
  description: z.string().trim().max(500).optional(),
  url: McpUrl,
  network: z.enum(['PUBLIC', 'INTERNAL']).default('PUBLIC'),
  /** SHARED = central connection; USER = template each user connects with their own credentials. */
  scope: z.enum(['SHARED', 'USER']).default('SHARED'),
});
export type CreateConnectionInput = z.input<typeof CreateConnectionInput>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept', 'cookie', 'idempotency-key', 'x-ocso-customer-claims']);

export const HeaderAuthInput = z.object({
  headerName: z
    .string()
    .trim()
    .regex(HEADER_NAME, 'must be a valid HTTP header name')
    .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()) && !h.toLowerCase().startsWith('mcp-'), 'this header is reserved'),
  /** Entered once; stored in the SecretStore and never returned. */
  token: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .refine((t) => !/[\r\n]/.test(t), 'must be a single line'),
});
export type HeaderAuthInput = z.infer<typeof HeaderAuthInput>;

const Scope = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/, 'invalid OAuth scope');

export const BeginOAuthInput = z
  .object({
    /** Admin-entered client for authorization servers without CIMD/DCR. */
    clientId: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(4_096).optional(),
    /** OCSO-hosted Client ID Metadata Document URL (preferred when the AS supports CIMD). */
    clientMetadataUrl: z.url({ protocol: /^https$/ }).max(2_048).optional(),
    /** Explicit scopes (e.g. a step-up union); default: challenge → PRM `scopes_supported`. */
    scopes: z.array(Scope).max(50).optional(),
    authorizationServer: z.url().max(2_048).optional(),
  })
  .refine((v) => !v.clientSecret || v.clientId, { message: 'clientSecret requires clientId', path: ['clientSecret'] });
export type BeginOAuthInput = z.infer<typeof BeginOAuthInput>;

/** Callback query. `error_description` is deliberately not accepted (attacker-controlled text). */
export const OAuthCallbackInput = z.object({
  code: z.string().max(4_096).optional(),
  state: z.string().max(512).optional(),
  iss: z.string().max(2_048).optional(),
  error: z.string().max(128).optional(),
});
export type OAuthCallbackInput = z.infer<typeof OAuthCallbackInput>;

export const HUMAN_ROLES = ['SERVICE', 'LEAD', 'HEAD', 'TECH'] as const;
const RiskClass = z.enum(['READ', 'WRITE', 'SENSITIVE']);

export const ClassifyToolsInput = z.object({
  tools: z
    .array(
      z.object({
        toolId: z.uuid(),
        riskClass: RiskClass,
        approved: z.boolean(),
        humanRoles: z.array(z.enum(HUMAN_ROLES)).max(HUMAN_ROLES.length).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ClassifyToolsInput = z.infer<typeof ClassifyToolsInput>;

export const ApproveConnectionInput = z.object({
  /** `'*'` = any agent the Lead enables; otherwise explicit agent ids. Must be empty for USER scope. */
  allowedAgentIds: z.union([z.literal('*'), z.array(z.uuid()).max(200)]),
  confirmationPolicy: z.enum(['SENSITIVE_ONLY', 'ALL_WRITES', 'NONE']).default('SENSITIVE_ONLY'),
  sendCustomerClaims: z.boolean().default(false),
  healthCheckSeconds: z.number().int().min(15).max(3_600).default(60),
});
export type ApproveConnectionInput = z.input<typeof ApproveConnectionInput>;

export const CreatePersonalConnectionInput = z.object({ templateId: z.uuid() });
export type CreatePersonalConnectionInput = z.infer<typeof CreatePersonalConnectionInput>;

const Scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const RULE_PATH = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,7}$/;

/** Mirrors `ArgumentRule` from @ocso/tools, with the value shape checked per operator. */
export const ArgumentRuleInput = z
  .object({
    path: z.string().regex(RULE_PATH, 'dotted argument path, e.g. payment.amount'),
    op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in', 'not_in', 'exists']),
    value: z.unknown().optional(),
    effect: z.enum(['REQUIRE_CONFIRMATION', 'DENY']),
    message: z.string().trim().min(1).max(300),
  })
  .superRefine((rule, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['value'], message });
    switch (rule.op) {
      case 'exists':
        if (rule.value !== undefined) bad('must be omitted for exists');
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) bad('must be a number');
        break;
      case 'eq':
      case 'neq':
        if (!Scalar.safeParse(rule.value).success) bad('must be a string, number, boolean or null');
        break;
      case 'in':
      case 'not_in':
        if (!z.array(Scalar).min(1).max(100).safeParse(rule.value).success) bad('must be a list of 1–100 scalar values');
        break;
    }
  });
export type ArgumentRuleInput = z.infer<typeof ArgumentRuleInput>;

export const SetAgentToolGrantsInput = z.object({
  grants: z
    .array(
      z.object({
        toolId: z.uuid(),
        enabled: z.boolean().default(true),
        alwaysConfirm: z.boolean().default(false),
        argumentRules: z.array(ArgumentRuleInput).max(20).default([]),
      }),
    )
    .max(500),
});
export type SetAgentToolGrantsInput = z.input<typeof SetAgentToolGrantsInput>;
