/** What a plugin adds, as short lines for the System page's Plugins panel (pure; unit tested). */
export interface PluginContributions {
  contributes: { channels: string[]; modelProviders: string[]; alertDestinations: string[]; emailDrivers: string[] };
  internal: string[];
}

const LABELS: ReadonlyArray<[keyof PluginContributions['contributes'], string]> = [
  ['channels', 'channels'],
  ['modelProviders', 'model providers'],
  ['alertDestinations', 'alert destinations'],
  ['emailDrivers', 'email drivers'],
];

/** "channels: ECHO" per non-empty kind, then the internal contributions; ["nothing registered"] when empty. */
export function contributionLines(plugin: PluginContributions): string[] {
  const lines = LABELS.flatMap(([key, label]) => (plugin.contributes[key].length ? [`${label}: ${plugin.contributes[key].join(', ')}`] : []));
  const all = [...lines, ...plugin.internal];
  return all.length ? all : ['nothing registered'];
}

/** "11 first-party · 2 installed". */
export function pluginCount(plugins: ReadonlyArray<{ source: string }>): string {
  const installed = plugins.filter((p) => p.source === 'installed').length;
  return `${plugins.length - installed} first-party · ${installed} installed`;
}
