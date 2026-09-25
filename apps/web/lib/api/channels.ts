import 'server-only';
import { cache } from 'react';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
import { ChannelMarkSchema } from '../channels';
import { api } from './client';

/** Channel administration (GET /v1/channels, packages/application/src/channels). Secrets are write-only. */
export const ChannelSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  status: z.string(),
  publicKey: z.string(),
  settings: z.record(z.string(), z.unknown()),
  /** Names of configured secrets → references; never values. */
  secretRefs: z.record(z.string(), z.string()),
  defaultAgentId: z.string().nullable(),
  /** The router its customers go through (PM/research/11 §5); null = new messages are rejected. */
  router: z.object({ id: z.string(), name: z.string(), status: z.string() }).nullable().default(null),
  lastInboundAt: z.string().nullable(),
  /** Provider webhook (`/channels/<segment>/<publicKey>/webhook`), for webhook kinds. */
  webhookPath: z.string().nullable(),
  /** Widget page (`/chat/<publicKey>`), for embeddable kinds. */
  embedPath: z.string().nullable().default(null),
  /** Maker–checker state (PM/research/11 §4): approved, the open proposal, whether an edit needs a checker. */
  approval: ObjectApprovalStateSchema.nullable().catch(null).default(null),
});
export type Channel = z.infer<typeof ChannelSchema>;

/** A secret the admin types (or generates); never returned by the API. */
export const ChannelSecretFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  hint: z.string().default(''),
  /** `server`: OCSO generates it when left empty. `client`: the form offers a generator (the admin must copy it elsewhere). */
  generate: z.enum(['server', 'client']).optional(),
  /** Prefix of generated values (e.g. `sk_`). */
  prefix: z.string().max(16).optional().catch(undefined),
  /** `once`: returned once on create and rotated from the edit form (the admin copies it to their backend). */
  reveal: z.literal('once').optional().catch(undefined),
});
export type ChannelSecretField = z.infer<typeof ChannelSecretFieldSchema>;

/** How a kind's message templates behave (descriptor `templates`; packages/channels contract/descriptor.ts). */
export const TemplateTermsSchema = z.object({
  reviewer: z.string(),
  placeholderScope: z.enum(['template', 'component']).catch('template'),
  mediaHeaderUnsupported: z.string().optional(),
});
export type TemplateTerms = z.infer<typeof TemplateTermsSchema>;

/** A setup file (descriptor `setupFiles`): a text template, or an `application/zip` package built by the API. */
export const SetupFileSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().optional(),
  filename: z.string(),
  contentType: z.enum(['application/json', 'text/yaml', 'text/plain', 'application/zip']),
  template: z.string().optional(),
  entries: z
    .array(z.object({ path: z.string(), contentType: z.string(), template: z.string().optional(), base64: z.string().optional() }))
    .optional(),
});

/** One step of a kind's setup guide (descriptor `setupGuide`; plain text only). */
export const SetupStepSchema = z.object({
  title: z.string(),
  body: z.string().default(''),
  items: z.array(z.string()).optional(),
  table: z.object({ head: z.tuple([z.string(), z.string()]), rows: z.array(z.tuple([z.string(), z.string()])) }).optional().catch(undefined),
  values: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  /** https only (the registry refuses others; the web app checks again before rendering). */
  links: z.array(z.object({ label: z.string(), href: z.string() })).optional(),
  files: z.array(z.string()).optional(),
  form: z.boolean().optional(),
  check: z.string().optional(),
});
export type SetupStep = z.infer<typeof SetupStepSchema>;

/**
 * GET /v1/channels/kinds: everything the web app knows about a channel kind
 * comes from its adapter's descriptor (form, labels, mark, setup steps,
 * template wording). Lenient: a kind from a newer plugin still parses.
 */
export const ChannelKindSchema = z.object({
  kind: z.string(),
  label: z.string().optional(),
  description: z.string().default(''),
  mark: ChannelMarkSchema.nullable().catch(null).default(null),
  settingsSchema: z.record(z.string(), z.unknown()).default({}),
  secrets: z.array(ChannelSecretFieldSchema).default([]),
  /** The non-secret setting the channel card shows (first key with a value). */
  identitySetting: z.object({ label: z.string(), keys: z.array(z.string()) }).nullable().catch(null).default(null),
  /** Deprecated plain-sentence steps (the API also serves them as `setupGuide`). */
  setupSteps: z.array(z.string()).catch([]).default([]),
  /** The step-by-step guide the dialog shows as a checklist (descriptor `setupGuide`). */
  setupGuide: z.array(SetupStepSchema).catch([]).default([]),
  /** Known problems and fixes; connection checks link to them by id. */
  troubleshooting: z.array(z.object({ id: z.string(), problem: z.string(), fix: z.string() })).catch([]).default([]),
  /** Files to paste or upload in the provider's console (app manifests, app packages), placeholders filled from the channel. */
  setupFiles: z.array(SetupFileSchema).catch([]).default([]),
  inboundWebhook: z.boolean().default(false),
  /** What the provider posts to the webhook, for the Webhooks list. */
  webhookEvents: z.string().optional(),
  embeddable: z.boolean().default(false),
  /** The adapter offers a read-only credential check (POST /v1/channels/:id/test). */
  connectionCheck: z.boolean().default(false),
  /** Customers can be reached with provider-approved message templates. */
  messageTemplates: z.boolean().default(false),
  templates: TemplateTermsSchema.nullable().catch(null).default(null),
});
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** POST /v1/channels/:id/test: read-only provider check; never includes secret values. */
export const ChannelTestSchema = z.object({
  ok: z.boolean(),
  /** `help`: id of the kind's troubleshooting entry that explains the fix. */
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), help: z.string().optional() })),
});
export type ChannelTestResult = z.infer<typeof ChannelTestSchema>;

export type ChannelStatus = 'ACTIVE' | 'DISABLED' | 'DRAFT';

export interface ChannelCreate {
  kind: string;
  name: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  /** Deprecated: routers decide who answers. */
  defaultAgentId?: string | null | undefined;
  /** Always created as a DRAFT (activation is a proposal). */
  status?: ChannelStatus | undefined;
}
/**
 * Settings replace the stored object; only the secrets listed are rotated (others are kept). A draft changes
 * directly; an approved channel answers 409 approval_required until `approval` names a checker (then 202).
 */
export type ChannelUpdate = Omit<ChannelCreate, 'kind' | 'status' | 'defaultAgentId'> & { approval?: { checkerId: string; reason: string } | { bootstrap: true; reason?: string | undefined } | undefined };

export const listChannels = () => api.get('/v1/channels', z.array(ChannelSchema));
export const listChannelKinds = () => api.get('/v1/channels/kinds', z.array(ChannelKindSchema));

/**
 * The kinds for display (marks, labels, template support), once per request.
 * Empty when the API refuses (a role that sees no channels) or is down: the
 * UI then shows channel names without marks.
 */
export const loadChannelKinds = cache((): Promise<ChannelKind[]> => listChannelKinds().catch((): ChannelKind[] => []));
/** A new channel is always a draft (its activation is a proposal). */
export const createChannel = (input: ChannelCreate) =>
  api.post('/v1/channels', { ...input, status: 'DRAFT' }, ChannelSchema.extend({ revealedSecrets: z.record(z.string(), z.string()).optional() }));
export const updateChannel = (id: string, input: ChannelUpdate) => api.patch(`/v1/channels/${id}`, input, z.union([ChannelSchema, ProposedSchema]));
export const testChannel = (id: string) => api.post(`/v1/channels/${id}/test`, undefined, ChannelTestSchema, { timeoutMs: 30_000 });
