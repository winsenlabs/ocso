import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Next.js App Router imports packages from Server Components: every module that uses hooks, context or browser
 * state, and the entry points, must start with the 'use client' directive, and the tsc build must keep it.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const DIRECTIVE = /^(['"])use client\1;/;
const CLIENT_API = /\b(createContext|useState|useEffect|useLayoutEffect|useRef|useMemo|useCallback|useContext|useSyncExternalStore|useReducer|useId)\b|from '\.\.?\/core\/(hooks|context)\.js'/;

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), ext) : ext.test(e.name) ? [join(dir, e.name)] : []));
}

let out: string;
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'ocso-chat-react-dist-'));
  execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json', '--outDir', out, '--declaration', 'false'], { cwd: root, stdio: 'pipe' });
}, 60_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("'use client' directive", () => {
  it('the built entry files start with "use client"', () => {
    for (const entry of ['index.js', 'native/index.js']) {
      expect(readFileSync(join(out, entry), 'utf8'), entry).toMatch(DIRECTIVE);
    }
  });

  it('every module using hooks or context starts with it, in source and in the build', () => {
    const client = files(join(root, 'src'), /\.tsx?$/).filter((f) => CLIENT_API.test(readFileSync(f, 'utf8')));
    expect(client.length).toBeGreaterThanOrEqual(9);
    for (const file of client) {
      const rel = relative(join(root, 'src'), file);
      expect(readFileSync(file, 'utf8'), rel).toMatch(DIRECTIVE);
      expect(readFileSync(join(out, rel.replace(/\.tsx?$/, '.js')), 'utf8'), `built ${rel}`).toMatch(DIRECTIVE);
    }
  });
});
