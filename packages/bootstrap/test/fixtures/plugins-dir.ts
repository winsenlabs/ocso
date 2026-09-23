import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The echo fixture plugin's source (a stand-in for a plugin built with the SDK). */
export const ECHO_SOURCE = readFileSync(new URL('./echo-plugin/index.js', import.meta.url), 'utf8');
export const ECHO_NAME = '@acme/ocso-plugin-echo';

export interface FixturePackage {
  name: string;
  version: string;
  /** package.json fields beyond name/version/type (exports, main…). */
  manifest?: Record<string, unknown>;
  /** Files relative to the package folder. */
  files: Record<string, string>;
}

/** The echo plugin installed as `name@version`. `override` (a JS object expression) replaces fields of its export. */
export function echoPackage(options: { name?: string; version?: string; override?: string; manifest?: Record<string, unknown> } = {}): FixturePackage {
  const files: Record<string, string> = { 'dist/index.js': ECHO_SOURCE };
  let entry = './dist/index.js';
  if (options.override) {
    files['dist/variant.js'] = `import base from './index.js';\nexport default { ...base, ...(${options.override}) };\n`;
    entry = './dist/variant.js';
  }
  return {
    name: options.name ?? ECHO_NAME,
    version: options.version ?? '1.0.0',
    manifest: options.manifest ?? { exports: { '.': { types: './dist/index.d.ts', import: entry } } },
    files,
  };
}

/** A throwaway OCSO_PLUGINS_DIR laid out like `npm install --prefix <dir>` leaves it. */
export function pluginsDir(packages: readonly FixturePackage[]): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ocso-plugins-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ocso-plugins', private: true }));
  for (const pkg of packages) {
    const root = join(dir, 'node_modules', pkg.name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', ...pkg.manifest }, null, 2));
    for (const [path, content] of Object.entries(pkg.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
