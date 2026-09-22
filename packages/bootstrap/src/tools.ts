import type { SettingsService } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { ToolProviderRegistry } from '@ocso/tools';
import { FIRST_PARTY_PLUGINS } from './first-party.js';
import { contributions, type OcsoPlugin } from './plugin.js';

/**
 * The runtime tool-provider registry: every plugin's `toolProviders` (built-in
 * OCSO tools, MCP connections) behind one registry, so every call — agent or
 * human, built-in or MCP — takes ToolRunner's / HumanToolService's single
 * authorization + tool_calls audit path.
 */
export function createRuntimeToolRegistry(
  db: Db,
  secrets: SecretStore,
  settings: SettingsService,
  plugins: readonly OcsoPlugin[] = FIRST_PARTY_PLUGINS,
): ToolProviderRegistry {
  const registry = new ToolProviderRegistry();
  for (const create of contributions(plugins, 'toolProviders')) registry.register(create({ db, secrets, settings }));
  return registry;
}
