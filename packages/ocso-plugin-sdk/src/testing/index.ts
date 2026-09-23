import { OCSO_PLUGIN_API_VERSION } from '../plugin.js';
import { checkAlertDestinations, checkChannels, checkEmailDrivers, checkModelProviders } from './checks.js';

export { CHECK_ALERT_DEPS, CHECK_CHANNEL_DEPS } from './checks.js';

/** Contribution keys plugin API version 1 accepts. */
export const PUBLIC_CONTRIBUTIONS = ['channels', 'modelProviders', 'alertDestinations', 'emailDrivers'] as const;

/** npm's limit on a package name; OCSO's loader applies it to plugin names. */
const MAX_NAME_LENGTH = 214;

/** The npm scope of OCSO's first-party plugins; installed plugins cannot use it. */
const RESERVED_SCOPE = '@ocso/';

/** Extension points OCSO has internally that plugins cannot contribute to in API version 1. */
const INTERNAL_ONLY = ['toolProviders', 'blobDrivers', 'secretsDrivers', 'queueDrivers', 'deploymentDrivers', 'auditStoreDrivers'] as const;

const CHECKERS: Readonly<Record<(typeof PUBLIC_CONTRIBUTIONS)[number], (items: readonly unknown[], problems: string[]) => void>> = {
  channels: checkChannels,
  modelProviders: checkModelProviders,
  alertDestinations: checkAlertDestinations,
  emailDrivers: checkEmailDrivers,
};

/**
 * Every problem OCSO would refuse the plugin for at start-up, as readable
 * lines; `[]` means OCSO's registries accept it. Runs the same checks the
 * registries run (kind patterns, marks, embed hooks, templates, webhook
 * segments, alert events, driver names) plus the plugin envelope
 * (`apiVersion`, `name`, no internal-only contribution keys; other extra
 * keys are ignored, as OCSO ignores them). Builds each channel and
 * alert destination with stand-in dependencies that have no network, so a
 * factory must not do I/O while it is being built.
 *
 * It cannot see clashes with other plugins (a kind another plugin already
 * registered): OCSO reports those when it starts.
 *
 * ```ts
 * import { checkPlugin } from '@winsendotai/ocso-plugin-sdk/testing';
 * expect(checkPlugin(plugin)).toEqual([]);
 * ```
 */
export function checkPlugin(plugin: unknown): string[] {
  if (typeof plugin !== 'object' || plugin === null) return ['a plugin must be an object (the default export of its module)'];
  const p = plugin as Record<string, unknown>;
  const problems: string[] = [];
  if (p['apiVersion'] !== OCSO_PLUGIN_API_VERSION) {
    problems.push(`apiVersion must be ${OCSO_PLUGIN_API_VERSION} (this SDK implements OCSO plugin API version ${OCSO_PLUGIN_API_VERSION}), got ${JSON.stringify(p['apiVersion']) ?? 'undefined'}`);
  }
  const name = p['name'];
  if (typeof name !== 'string' || !name.trim()) problems.push('an OCSO plugin needs a name (by convention its npm package name)');
  else if (name !== name.trim()) problems.push(`plugin name "${name}" has leading or trailing spaces`);
  else if (name.length > MAX_NAME_LENGTH) problems.push(`plugin name is ${name.length} characters long (at most ${MAX_NAME_LENGTH}, like an npm package name)`);
  else if (name.startsWith(RESERVED_SCOPE)) problems.push(`plugin name "${name}" is in the ${RESERVED_SCOPE} scope, which is reserved for OCSO's first-party plugins`);
  // Like OCSO's loader: internal-only extension points are refused; other extra keys are ignored.
  for (const key of INTERNAL_ONLY) {
    if (p[key] !== undefined) problems.push(`${key} cannot be contributed by a plugin in plugin API version 1`);
  }
  for (const key of PUBLIC_CONTRIBUTIONS) {
    const items = p[key];
    if (items === undefined) continue;
    if (!Array.isArray(items)) {
      problems.push(`${key} must be an array`);
      continue;
    }
    CHECKERS[key](items, problems);
  }
  return problems;
}
