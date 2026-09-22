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

export const listChannels = () => api.get('/v1/channels', z.array(ChannelSchema));
/** Adapter kinds registered in this deployment (no field descriptors yet). */
export const listChannelKinds = () => api.get('/v1/channels/kinds', z.array(z.object({ kind: z.string() })));
