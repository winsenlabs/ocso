/**
 * Plugin-boundary guard (ADR-028: "the plugin boundary is the product").
 * Core code never names a specific plugin kind: no quoted `'WHATSAPP'`,
 * `'OPENAI'`, `'SLACK'`… literals and no per-kind object keys — per-kind
 * knowledge lives in the plugin and reaches core through its registry.
 *
 * The kinds are not listed here. They are derived from the plugins the
 * composition root compiles in (`name: '@ocso/…'` entries of
 * FIRST_PARTY_PLUGINS in packages/bootstrap/src/first-party.ts), so a new
 * plugin is covered as soon as it is listed there:
 *   - plugin kinds: `kind: 'X'` / `kind = 'X'` (UPPER_SNAKE) declared in a
 *     plugin package's src — channel adapters/descriptors, provider
 *     definitions, alert adapters;
 *   - driver names: `driver: 'x'` / `driver = 'x'` in a plugin package's src
 *     and `name: 'x'` in any file defining *DriverDefinition objects (plugin
 *     packages and the composition root). Driver names are everyday words
 *     (`log`, `local`, `postgres`), so they count only on a line whose code
 *     (not its comment) mentions a driver.
 * A package that is itself core (e.g. agent-runtime, which ships the built-in
 * tools) contributes no kinds: its declarations are scanned as core.
 *
 * Core = the directories in CORE_ROOTS, minus seeds, tests, e2e, fixtures and
 * migrations. A line may opt out with a reasoned comment on the same line or
 * the line above: `// plugin-boundary: allow <reason>`. Keep that count at zero.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const CORE_ROOTS = [
  'apps/api/src',
  'apps/worker/src',
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'packages/application/src',
  'packages/agent-runtime/src',
  'packages/domain/src',
  'packages/db/src/schema',
  'packages/auth/src',
  'packages/events/src',
  'packages/prompt-compiler/src',
];
/** Core paths where naming a kind is expected: seeds and test material (incl. `src/testing/` doubles). */
const CORE_EXEMPT = [
  /^apps\/api\/src\/seed\//,
  /^packages\/application\/src\/alerts\/seed\.ts$/,
  /(?:^|\/)(?:test|tests|testing|__tests__|e2e|fixtures|__fixtures__|migrations)\//,
  /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/,
];
export const COMPOSITION_ROOT = 'packages/bootstrap/src/first-party.ts';
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'migrations', 'generated', '__generated__']);
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/;
const PLUGIN_ENTRY = /\bname\s*:\s*['"](@[^'"\s]+)['"]/g;
const KIND_DECL = /\bkind\s*[:=]\s*['"]([A-Z][A-Z0-9_]{1,39})['"]/g;
const DRIVER_DECL = /\bdriver\s*[:=]\s*['"]([a-z][a-z0-9-]{0,39})['"]/g;
const DRIVER_NAME_DECL = /\bname\s*:\s*['"]([a-z][a-z0-9-]{0,39})['"]/g;
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const OBJECT_KEY = /(?<![\w$.])([A-Z][A-Z0-9_]{1,39})\s*\??:(?!:)/g;
const MENTIONS_DRIVER = /driver/i;
const ESCAPE = /\/\/\s*plugin-boundary:\s*allow\s+\S/;

const toPosix = (p) => p.split(sep).join('/');

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !/\.d\.(?:ts|mts|cts)$/.test(entry.name)) out.push(join(dir, entry.name));
  }
  return out;
}

const isCorePath = (rel) => CORE_ROOTS.some((r) => rel === r || rel.startsWith(`${r}/`));

function harvest(regex, code, into, owner) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(code))) if (!into.has(m[1])) into.set(m[1], owner);
}

/**
 * Kinds and driver names declared by the compiled-in plugins, with the
 * package that declares each (for messages).
 */
export function derivePluginVocabulary(root, workspaces, stripNonCode) {
  const kinds = new Map();
  const drivers = new Map();
  const rootFile = join(root, COMPOSITION_ROOT);
  if (!existsSync(rootFile)) return { plugins: [], kinds, drivers };
  const rootCode = stripNonCode(readFileSync(rootFile, 'utf8'));
  const names = new Set();
  PLUGIN_ENTRY.lastIndex = 0;
  let m;
  while ((m = PLUGIN_ENTRY.exec(rootCode))) names.add(m[1]);
  const plugins = workspaces.filter((ws) => names.has(ws.name) && !isCorePath(`${ws.relDir}/src`));
  const compositionWs = workspaces.find((ws) => rootFile.startsWith(ws.dir + sep));
  const scan = [...plugins.map((ws) => ({ ws, plugin: true })), ...(compositionWs ? [{ ws: compositionWs, plugin: false }] : [])];
  for (const { ws, plugin } of scan) {
    for (const file of walk(join(ws.dir, 'src'), [])) {
      if (TEST_FILE.test(file)) continue;
      const code = stripNonCode(readFileSync(file, 'utf8'));
      if (plugin) {
        harvest(KIND_DECL, code, kinds, ws.name);
        harvest(DRIVER_DECL, code, drivers, ws.name);
      }
      if (code.includes('DriverDefinition')) harvest(DRIVER_NAME_DECL, code, drivers, ws.name);
    }
  }
  return { plugins: plugins.map((ws) => ws.name).sort(), kinds, drivers };
}

function escaped(srcLines, i) {
  if (ESCAPE.test(srcLines[i] ?? '')) return true;
  const above = (srcLines[i - 1] ?? '').trim();
  return above.startsWith('//') && ESCAPE.test(above);
}

/** Violations of one core file: quoted kind literals, per-kind object keys, driver names in driver context. */
export function checkCoreFile(relFile, text, vocabulary, stripNonCode) {
  const violations = [];
  const escapes = [];
  const codeLines = stripNonCode(text).split('\n');
  const srcLines = text.split('\n');
  codeLines.forEach((line, i) => {
    const found = [];
    STRING_LITERAL.lastIndex = 0;
    let m;
    while ((m = STRING_LITERAL.exec(line))) {
      const value = m[2];
      if (vocabulary.kinds.has(value)) found.push({ literal: value, kind: 'kind', owner: vocabulary.kinds.get(value) });
      else if (vocabulary.drivers.has(value) && MENTIONS_DRIVER.test(line)) {
        found.push({ literal: value, kind: 'driver', owner: vocabulary.drivers.get(value) });
      }
    }
    const keys = line.replace(STRING_LITERAL, (s) => ' '.repeat(s.length));
    OBJECT_KEY.lastIndex = 0;
    while ((m = OBJECT_KEY.exec(keys))) {
      if (vocabulary.kinds.has(m[1])) found.push({ literal: m[1], kind: 'key', owner: vocabulary.kinds.get(m[1]) });
    }
    if (!found.length) return;
    const at = `${relFile}:${i + 1}`;
    if (escaped(srcLines, i)) {
      escapes.push({ at, literals: found.map((f) => f.literal) });
      return;
    }
    for (const f of found) {
      const what = f.kind === 'driver' ? `driver name "${f.literal}"` : f.kind === 'key' ? `per-kind key ${f.literal}` : `kind "${f.literal}"`;
      violations.push({ rule: `plugin-${f.kind}`, at, literal: f.literal, message: `core code names ${what} (declared by ${f.owner}); use the registry/descriptor instead` });
    }
  });
  return { violations, escapes };
}

/** The whole check: vocabulary from the plugins, then every core file. */
export function checkPluginBoundary(root, workspaces, stripNonCode) {
  const vocabulary = derivePluginVocabulary(root, workspaces, stripNonCode);
  const violations = [];
  const escapes = [];
  let scanned = 0;
  if (vocabulary.kinds.size || vocabulary.drivers.size) {
    for (const coreRoot of CORE_ROOTS) {
      for (const file of walk(join(root, coreRoot), [])) {
        const rel = toPosix(relative(root, file));
        if (CORE_EXEMPT.some((re) => re.test(rel))) continue;
        scanned++;
        const result = checkCoreFile(rel, readFileSync(file, 'utf8'), vocabulary, stripNonCode);
        violations.push(...result.violations);
        escapes.push(...result.escapes);
      }
    }
  }
  return {
    plugins: vocabulary.plugins,
    kinds: [...vocabulary.kinds.keys()].sort(),
    drivers: [...vocabulary.drivers.keys()].sort(),
    scanned,
    violations,
    escapes,
  };
}
