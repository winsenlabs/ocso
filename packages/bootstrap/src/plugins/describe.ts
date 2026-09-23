import type { DeliveryAdapterDeps } from '@ocso/alerts';
import { NO_NETWORK, type ChannelAdapterDeps } from '@ocso/channels';
import type { OcsoPlugin } from '../plugin.js';

/** A plugin installed from npm by the loader (OCSO_PLUGINS), as opposed to one compiled into this build. */
export interface InstalledPlugin extends OcsoPlugin {
  readonly source: 'installed';
  /** The installed package's version (equal to the version OCSO_PLUGINS pins). */
  readonly version: string;
  /** The npm package the plugin came from (by convention also its `name`). */
  readonly packageName: string;
}

export const isInstalledPlugin = (plugin: OcsoPlugin): plugin is InstalledPlugin => (plugin as Partial<InstalledPlugin>).source === 'installed';

/** What `GET /v1/system/plugins` serves per plugin. */
export interface PluginInfo {
  name: string;
  version: string;
  source: 'first-party' | 'installed';
  /** The public (plugin API v1) contributions: channel, model provider and alert destination kinds; email driver names. */
  contributes: { channels: string[]; modelProviders: string[]; alertDestinations: string[]; emailDrivers: string[] };
  /** First-party only: contributions through internal contracts (infrastructure drivers, tool sources), for the record. */
  internal: string[];
}

const noEgress = (): Promise<never> => Promise.reject(new Error('plugin description has no network access'));

/** Host deps for building an adapter only to read its kind: no network, no mail. */
export const DESCRIBE_CHANNEL_DEPS: ChannelAdapterDeps = { fetch: NO_NETWORK, now: () => new Date() };
export const DESCRIBE_ALERT_DEPS: DeliveryAdapterDeps = {
  fetch: noEgress,
  mailTransport: () => {
    throw new Error('plugin description has no mail transport');
  },
  emailSender: null,
};

const kindOf = (build: () => { kind: string }): string => {
  try {
    return build().kind;
  } catch {
    return '?';
  }
};

/** The kinds and names a plugin contributes (factories are built with inert deps to read their kind). */
export function pluginContributions(plugin: OcsoPlugin): PluginInfo['contributes'] {
  return {
    channels: (plugin.channels ?? []).map((create) => kindOf(() => create(DESCRIBE_CHANNEL_DEPS))),
    modelProviders: (plugin.modelProviders ?? []).map((definition) => definition.kind),
    alertDestinations: (plugin.alertDestinations ?? []).map((create) => kindOf(() => create(DESCRIBE_ALERT_DEPS))),
    emailDrivers: (plugin.emailDrivers ?? []).map((driver) => driver.name),
  };
}

function internalContributions(plugin: OcsoPlugin): string[] {
  const named = (label: string, drivers: readonly { name: string }[] | undefined) => (drivers?.length ? [`${label}: ${drivers.map((d) => d.name).join(', ')}`] : []);
  return [
    ...(plugin.toolProviders?.length ? [`tool sources: ${plugin.toolProviders.length}`] : []),
    ...named('blob drivers', plugin.blobDrivers),
    ...named('secrets drivers', plugin.secretsDrivers),
    ...named('queue drivers', plugin.queueDrivers),
    ...named('deployment drivers', plugin.deploymentDrivers),
    ...named('audit store drivers', plugin.auditStoreDrivers),
  ];
}

/**
 * Every plugin this process runs, in load order. First-party plugins carry
 * the OCSO build's version (`APP_VERSION`); installed ones their package's.
 */
export function describePlugins(plugins: readonly OcsoPlugin[], firstPartyVersion: string): PluginInfo[] {
  return plugins.map((plugin) =>
    isInstalledPlugin(plugin)
      ? { name: plugin.name, version: plugin.version, source: 'installed', contributes: pluginContributions(plugin), internal: [] }
      : { name: plugin.name, version: firstPartyVersion, source: 'first-party', contributes: pluginContributions(plugin), internal: internalContributions(plugin) },
  );
}

/** One start-up log line: every plugin with its version, so api and worker lists can be compared. */
export function pluginSummary(plugins: readonly OcsoPlugin[], firstPartyVersion: string): string {
  const installed = plugins.filter(isInstalledPlugin);
  const firstParty = plugins.filter((p) => !isInstalledPlugin(p));
  const list = (items: string[]) => (items.length ? items.join(', ') : 'none');
  return (
    `plugins: first-party ${list(firstParty.map((p) => `${p.name}@${firstPartyVersion}`))}; ` +
    `installed ${list(installed.map((p) => (p.packageName === p.name ? `${p.name}@${p.version}` : `${p.name} (${p.packageName}@${p.version})`)))}`
  );
}
