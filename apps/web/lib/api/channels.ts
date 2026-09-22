import 'server-only';
import { z } from 'zod';
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
  lastInboundAt: z.string().nullable(),
  webhookPath: z.string().nullable(),
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
});
export type ChannelSecretField = z.infer<typeof ChannelSecretFieldSchema>;

/** GET /v1/channels/kinds: what the Add channel form needs per adapter (settings as JSON Schema, input shape). */
export const ChannelKindSchema = z.object({
  kind: z.string(),
  label: z.string().optional(),
  description: z.string().default(''),
  settingsSchema: z.record(z.string(), z.unknown()).default({}),
  secrets: z.array(ChannelSecretFieldSchema).default([]),
  inboundWebhook: z.boolean().default(false),
  embeddable: z.boolean().default(false),
});
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

export type ChannelStatus = 'ACTIVE' | 'DISABLED' | 'DRAFT';

export interface ChannelCreate {
  kind: string;
  name: string;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  defaultAgentId: string | null;
  status: ChannelStatus;
}
/** Settings replace the stored object; only the secrets listed are rotated (others are kept). */
export type ChannelUpdate = Omit<ChannelCreate, 'kind'>;

export const listChannels = () => api.get('/v1/channels', z.array(ChannelSchema));
export const listChannelKinds = () => api.get('/v1/channels/kinds', z.array(ChannelKindSchema));
export const createChannel = (input: ChannelCreate) => api.post('/v1/channels', input, ChannelSchema);
export const updateChannel = (id: string, input: ChannelUpdate) => api.patch(`/v1/channels/${id}`, input, ChannelSchema);
