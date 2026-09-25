import { realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIRST_PARTY_PLUGINS } from '../first-party.js';
import type { OcsoPlugin } from '../plugin.js';
import type { InstalledPlugin } from './describe.js';
import { guardFunction, guardObject, translateEmailPluginError, type GuardSpec } from './errors.js';
import { pluginShapeProblems, registryProblem } from './validate.js';

/**
 * The plugin loader (docs/guides/extending/install-a-plugin.md). The operator lists the
 * plugins a deployment runs, each pinned to an exact version:
 *
 *   OCSO_PLUGINS=@acme/ocso-channel-line@1.2.3,@acme/ocso-alerts-opsgenie@0.4.0
 *   OCSO_PLUGINS_DIR=/app/plugins      # default; packages in <dir>/node_modules/<name>
 *
 * Both are read from the raw environment (loadEnv strips unknown keys). A
 * plugin that is missing, installed at another version, built for another
 * plugin API version, named like another plugin, or whose contributions the
 * registries refuse stops the process at start-up with every problem listed.
 * Installed plugins run in-process with full trust: install only code you trust.
 */
export const DEFAULT_PLUGINS_DIR = '/app/plugins';

export interface PluginPin {
  /** npm package name, e.g. `@acme/ocso-channel-line`. */
  readonly name: string;
  /** Exact version, e.g. `1.2.3` (ranges are refused). */
  readonly version: string;
}

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `OCSO_PLUGINS` as pins, plus the problems of entries that are not `name@exactVersion`. */
export function parsePluginList(value: string | undefined): { pins: PluginPin[]; problems: string[] } {
  const pins: PluginPin[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const raw of (value ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const at = entry.lastIndexOf('@');
    const name = at > 0 ? entry.slice(0, at) : entry;
    const version = at > 0 ? entry.slice(at + 1) : '';
    if (!PACKAGE_NAME.test(name) || name.length > 214) {
      problems.push(`${entry}: not an npm package name`);
    } else if (!EXACT_VERSION.test(version)) {
      problems.push(`${entry}: pin an exact version (name@x.y.z); ranges and tags are refused`);
    } else if (seen.has(name)) {
      problems.push(`${name} is listed twice`);
    } else {
      seen.add(name);
      pins.push({ name, version });
    }
  }
  return { pins, problems };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The conditions Node matches for `import()` of a package (plus `default`, which always matches). */
const IMPORT_CONDITIONS = new Set(['node', 'import', 'default']);
/** Node's ESM legacy `main` resolution (legacyMainResolve): the files it tries, in order, relative to `main`. */
const MAIN_SUFFIXES = ['', '.js', '.json', '.node', '/index.js', '/index.json', '/index.node'];
const INDEX_FALLBACKS = ['./index.js', './index.json', './index.node'];

class InvalidTarget extends Error {}

/**
 * PACKAGE_TARGET_RESOLVE for the "." subpath (Node ESM resolution): a string target must be `./…` with no `..`,
 * `.` or `node_modules` segments; arrays try each entry, skipping invalid ones; objects match conditions in key
 * order; `null` is an explicit "not exported". Returns undefined when nothing matches.
 */
function exportTarget(value: unknown): string | null | undefined {
  if (typeof value === 'string') {
    const segments = value.split(/[/\\]/).slice(1);
    if (!value.startsWith('./') || segments.some((s) => s === '..' || s === '.' || s.toLowerCase() === 'node_modules')) throw new InvalidTarget(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length) return null;
    let last: unknown;
    for (const item of value) {
      try {
        const target = exportTarget(item);
        if (target === undefined) continue;
        return target;
      } catch (error) {
        last = error;
        if (!(error instanceof InvalidTarget)) throw error;
      }
    }
    if (last) throw last;
    return null;
  }
  if (value === null) return null;
  if (!isRecord(value)) throw new InvalidTarget(String(value));
  for (const [condition, next] of Object.entries(value)) {
    if (!IMPORT_CONDITIONS.has(condition)) continue;
    const target = exportTarget(next);
    if (target !== undefined) return target;
  }
  return undefined;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Absolute path of a package's entry for `import('<name>')`, resolved the way Node resolves it (ESM, conditions
 * node/import/default): `exports["."]` when the package has `exports`, else the legacy `main` lookup (extensions,
 * folder index) and finally `index.js`. The entry must exist and, symlinks followed, stay inside the package.
 */
export function packageEntry(pkg: Record<string, unknown>, packageDir: string): string {
  const exportsField = pkg['exports'];
  let entry: string | undefined;
  let target: string;
  if (exportsField !== undefined && exportsField !== null) {
    let root: unknown = exportsField;
    if (isRecord(exportsField)) {
      const keys = Object.keys(exportsField);
      const dotted = keys.filter((k) => k.startsWith('.'));
      if (dotted.length && dotted.length !== keys.length) throw new Error('its package.json "exports" mixes subpaths and conditions');
      if (dotted.length) root = exportsField['.'];
    }
    let resolved: string | null | undefined;
    try {
      resolved = exportTarget(root);
    } catch (error) {
      if (error instanceof InvalidTarget) throw new Error(`its entry ${error.message} points outside the package (package.json "exports" targets must be ./ paths inside it)`);
      throw error;
    }
    if (!resolved) throw new Error('its package.json "exports" has no import entry for "."');
    target = resolved;
    entry = resolve(packageDir, target);
    if (!isFile(entry)) throw new Error(`its entry ${target} (package.json "exports") does not exist`);
  } else {
    const main = typeof pkg['main'] === 'string' && pkg['main'] ? pkg['main'] : null;
    const candidates = [...(main ? MAIN_SUFFIXES.map((suffix) => `${main}${suffix}`) : []), ...INDEX_FALLBACKS];
    target = main ?? './index.js';
    entry = candidates.map((c) => resolve(packageDir, c)).find((c) => isInside(packageDir, c) && isFile(c));
    if (!entry) {
      if (main && !isInside(packageDir, resolve(packageDir, main))) throw new Error(`its entry ${main} points outside the package`);
      throw new Error(`its entry ${target} (package.json "main") does not exist`);
    }
  }
  if (!isInside(packageDir, entry)) throw new Error(`its entry ${target} points outside the package`);
  // Symlinks followed: a link inside the package must not lead out of it (Node imports the real path).
  const real = realpathSync(entry);
  if (!isInside(realpathSync(packageDir), real)) throw new Error(`its entry ${target} points outside the package`);
  return real;
}

function isInside(dir: string, path: string): boolean {
  const inside = relative(dir, path);
  return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
}

const CHANNEL_ADAPTER: GuardSpec = { props: { embed: {} } };
const PROVIDER_DEFINITION: GuardSpec = { props: { catalog: {} }, returns: { create: {} } };
/** A driver's sender throws what core email callers read: EmailSendError (see translateEmailPluginError). */
const EMAIL_DRIVER: GuardSpec = { returns: { create: { translate: translateEmailPluginError } } };

type Factory = (...args: never[]) => unknown;

/** The internal plugin record for a validated export: contributions guarded so marked errors become DomainErrors. */
function installedPlugin(exported: Record<string, unknown>, pin: PluginPin): InstalledPlugin {
  const each = <T>(key: string, guard: (item: never) => unknown): T | undefined =>
    Array.isArray(exported[key]) ? ((exported[key] as never[]).map(guard) as T) : undefined;
  return {
    name: exported['name'] as string,
    source: 'installed',
    version: pin.version,
    packageName: pin.name,
    channels: each('channels', (create: Factory) => guardFunction(create, undefined, CHANNEL_ADAPTER)),
    modelProviders: each('modelProviders', (definition: object) => guardObject(definition, PROVIDER_DEFINITION)),
    alertDestinations: each('alertDestinations', (create: Factory) => guardFunction(create, undefined, {})),
    emailDrivers: each('emailDrivers', (driver: object) => guardObject(driver, EMAIL_DRIVER)),
  };
}

const declaresApi = (value: unknown) => isRecord(value) && value['apiVersion'] !== undefined;

/**
 * The plugin a module exports: `default`, else the `plugin` named export; whichever candidate declares an
 * apiVersion wins. For a CommonJS module Node's `default` is `module.exports`, so `exports.plugin = …` arrives as
 * `default.plugin`, and TypeScript's CommonJS output of `export default plugin` (`exports.default = plugin`,
 * `__esModule`) arrives as `default.default`.
 */
export function pluginExport(mod: Record<string, unknown>): unknown {
  const fallback = mod['default'] ?? mod['plugin'];
  const inner = isRecord(mod['default']) ? mod['default'] : undefined;
  const candidates = [mod['default'], mod['plugin'], inner?.['default'], inner?.['plugin']];
  return candidates.find(declaresApi) ?? fallback;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface LoadPluginsOptions {
  /** Where OCSO_PLUGINS and OCSO_PLUGINS_DIR are read (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** The plugins compiled into this build; installed names and kinds must not clash with them. */
  firstParty?: readonly OcsoPlugin[];
  /** Receives one line per loaded plugin. */
  log?: (line: string) => void;
}

/**
 * Loads, checks and returns the plugins OCSO_PLUGINS lists, in that order
 * (append them to FIRST_PARTY_PLUGINS). Throws `Invalid OCSO plugin
 * configuration` listing every problem, so a bad list stops start-up.
 */
export async function loadConfiguredPlugins(options: LoadPluginsOptions = {}): Promise<InstalledPlugin[]> {
  const env = options.env ?? process.env;
  const firstParty = options.firstParty ?? FIRST_PARTY_PLUGINS;
  const { pins, problems } = parsePluginList(env['OCSO_PLUGINS']);
  if (!pins.length && !problems.length) return [];
  const dir = resolve(env['OCSO_PLUGINS_DIR']?.trim() || DEFAULT_PLUGINS_DIR);
  const loaded: InstalledPlugin[] = [];
  for (const pin of pins) {
    const refuse = (problem: string) => problems.push(`${pin.name}@${pin.version} ${problem}`);
    const packageDir = join(dir, 'node_modules', pin.name);
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      refuse(`is not installed in ${dir} (npm install --prefix ${dir} ${pin.name}@${pin.version})`);
      continue;
    }
    if (pkg['name'] !== pin.name) {
      refuse(`is expected in ${packageDir}, but that folder holds package ${JSON.stringify(pkg['name'])}`);
      continue;
    }
    if (pkg['version'] !== pin.version) {
      refuse(`is pinned, but ${String(pkg['version'])} is installed in ${dir}; install the pinned version or change OCSO_PLUGINS`);
      continue;
    }
    let exported: unknown;
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(packageEntry(pkg, packageDir)).href)) as Record<string, unknown>;
      exported = pluginExport(mod);
    } catch (error) {
      refuse(`could not be loaded: ${message(error)}`);
      continue;
    }
    const taken = new Set([...firstParty, ...loaded].map((p) => p.name));
    const shape = pluginShapeProblems(exported, taken);
    if (shape.length) {
      for (const problem of shape) refuse(problem);
      continue;
    }
    const plugin = installedPlugin(exported as Record<string, unknown>, pin);
    const refused = registryProblem([...firstParty, ...loaded, plugin]);
    if (refused) {
      refuse(`has an invalid contribution: ${refused}`);
      continue;
    }
    loaded.push(plugin);
  }
  if (problems.length) throw new Error(`Invalid OCSO plugin configuration (OCSO_PLUGINS):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  for (const plugin of loaded) options.log?.(`loaded plugin ${plugin.name} from ${plugin.packageName}@${plugin.version} (${dir})`);
  return loaded;
}

/** FIRST_PARTY_PLUGINS followed by the installed ones: what the api, the worker and the seed run. */
export async function loadPlugins(options: LoadPluginsOptions = {}): Promise<OcsoPlugin[]> {
  const firstParty = options.firstParty ?? FIRST_PARTY_PLUGINS;
  return [...firstParty, ...(await loadConfiguredPlugins({ ...options, firstParty }))];
}
