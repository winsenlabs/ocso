import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * The plugins the deployment runs: GET /v1/system/plugins (system.read).
 * First-party plugins are compiled into OCSO; installed ones come from
 * OCSO_PLUGINS at a pinned version (docs/guides/extending/install-a-plugin.md).
 */

const kinds = z.array(z.string()).default([]);

export const PluginInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.enum(['first-party', 'installed']).catch('installed'),
  contributes: z
    .object({ channels: kinds, modelProviders: kinds, alertDestinations: kinds, emailDrivers: kinds })
    .default({ channels: [], modelProviders: [], alertDestinations: [], emailDrivers: [] }),
  internal: z.array(z.string()).default([]),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const listPlugins = () => api.get('/v1/system/plugins', z.array(PluginInfoSchema));
