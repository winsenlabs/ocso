import { createAlertDeliveryRegistry } from '../alerts.js';
import { createDriverRegistries } from '../adapters.js';
import { createChannelRegistry } from '../channels.js';
import { createProviderRegistry } from '../model-adapters.js';
import type { OcsoPlugin } from '../plugin.js';
import { DESCRIBE_ALERT_DEPS, DESCRIBE_CHANNEL_DEPS } from './describe.js';

/** The plugin API version this host implements (`@winsendotai/ocso-plugin-sdk` `OCSO_PLUGIN_API_VERSION`). */
export const OCSO_PLUGIN_API_VERSION = 1;

/** What an installed plugin may contribute in plugin API v1. */
export const INSTALLABLE_CONTRIBUTIONS = ['channels', 'modelProviders', 'alertDestinations', 'emailDrivers'] as const;

/** Contributions whose contracts are internal (they need @ocso/db, @ocso/config): first-party only in v1. */
const INTERNAL_CONTRIBUTIONS = ['toolProviders', 'blobDrivers', 'secretsDrivers', 'queueDrivers', 'deploymentDrivers', 'auditStoreDrivers'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Problems with a module's plugin export before anything of it runs: the
 * API version handshake, the name, and the shape of each contribution list.
 * The contributions' own rules (kind patterns, marks, embed, templates,
 * webhook segments, alert events, driver names) are checked by the host's
 * registries in `registryProblem`, the same code that registers them.
 */
export function pluginShapeProblems(candidate: unknown, reservedNames: ReadonlySet<string>): string[] {
  if (!isRecord(candidate)) return ['exports no plugin (expected `export default definePlugin({...})` or a `plugin` export)'];
  const problems: string[] = [];
  const apiVersion = candidate['apiVersion'];
  if (apiVersion !== OCSO_PLUGIN_API_VERSION) {
    problems.push(
      apiVersion === undefined
        ? `declares no apiVersion; this OCSO runs plugin API version ${OCSO_PLUGIN_API_VERSION} (build the plugin with @winsendotai/ocso-plugin-sdk definePlugin)`
        : `is built for plugin API version ${JSON.stringify(apiVersion)}; this OCSO runs plugin API version ${OCSO_PLUGIN_API_VERSION}. Install a plugin release for API version ${OCSO_PLUGIN_API_VERSION}`,
    );
    return problems;
  }
  const name = candidate['name'];
  if (typeof name !== 'string' || !name.trim()) problems.push('has no name');
  else if (name !== name.trim() || name.length > 214) problems.push(`has an invalid name ${JSON.stringify(name)}`);
  else if (reservedNames.has(name)) problems.push(`is named ${name}, which is already taken by a first-party or another installed plugin`);
  else if (name.startsWith('@ocso/')) problems.push(`is named ${name}; the @ocso/ scope is reserved for first-party plugins`);

  for (const key of INTERNAL_CONTRIBUTIONS) {
    if (candidate[key] !== undefined) {
      problems.push(`contributes ${key}, which installed plugins cannot contribute in plugin API v${OCSO_PLUGIN_API_VERSION} (supported: ${INSTALLABLE_CONTRIBUTIONS.join(', ')})`);
    }
  }
  const list = (key: string, check: (item: unknown) => boolean, expected: string) => {
    const value = candidate[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) return problems.push(`${key} must be an array`);
    value.forEach((item, i) => {
      if (!check(item)) problems.push(`${key}[${i}] must be ${expected}`);
    });
  };
  const fn = (item: unknown) => typeof item === 'function';
  list('channels', fn, 'a channel adapter factory (deps) => ChannelAdapter');
  list('alertDestinations', fn, 'an alert delivery adapter factory (deps) => AlertDeliveryAdapter');
  list('modelProviders', (d) => isRecord(d) && typeof d['kind'] === 'string' && typeof d['create'] === 'function', 'a provider definition with a kind and create()');
  list(
    'emailDrivers',
    (d) => isRecord(d) && typeof d['name'] === 'string' && typeof d['resolve'] === 'function' && typeof d['create'] === 'function',
    'an email driver definition with a name, resolve() and create()',
  );
  return problems;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Registers `plugins` into throwaway registries (inert deps: no network, no
 * mail, dev providers on so every kind is checked) and returns the first
 * refusal, or null. This runs exactly the registration checks the api and
 * worker run, including clashes with kinds other plugins already registered.
 */
export function registryProblem(plugins: readonly OcsoPlugin[]): string | null {
  const steps: Array<() => unknown> = [
    () => createChannelRegistry({ ...DESCRIBE_CHANNEL_DEPS }, plugins).describeAll(),
    () => createProviderRegistry({ OCSO_ENABLE_DEV_PROVIDERS: true }, plugins),
    () => createAlertDeliveryRegistry(DESCRIBE_ALERT_DEPS, plugins).describe(),
    () => createDriverRegistries(plugins),
  ];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      return message(error);
    }
  }
  return null;
}
