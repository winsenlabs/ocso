/**
 * `pnpm capabilities:generate` — regenerate the Ask OCSO capability catalog
 * (packages/internal-agent/src/catalog/capabilities.generated.json) from the API.
 * `--check` only compares and exits 1 when the committed file is stale.
 *
 * The controllers are TypeScript with legacy decorators and workspace sources
 * (`@ocso/source`), so they load through Vite's module runner with the same
 * resolution as the tests (vitest.config.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const check = process.argv.includes('--check');

const server = await createServer({
  root,
  configFile: join(root, 'vitest.config.ts'),
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
let code = 0;
try {
  const { extractCatalog, serializeCatalog, CATALOG_PATH } = await runner.import(join(root, 'scripts/capabilities/extract.mjs'));
  let catalog;
  try {
    catalog = await extractCatalog();
  } catch (err) {
    console.error(err instanceof Error ? (process.env.DEBUG ? err.stack : err.message) : err);
    code = 1;
  }
  if (catalog) {
    const text = serializeCatalog(catalog);
    const current = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH, 'utf8') : '';
    const rel = relative(root, CATALOG_PATH);
    const counts = catalog.capabilities.reduce((acc, c) => ((acc[c.risk] = (acc[c.risk] ?? 0) + 1), acc), {});
    const summary = `${catalog.capabilities.length} capabilities (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}), ${catalog.excluded.length} routes excluded`;
    if (check) {
      if (current === text) console.log(`${rel} is current: ${summary}`);
      else {
        console.error(`${rel} is stale: run \`pnpm capabilities:generate\` and commit the result.`);
        code = 1;
      }
    } else if (current === text) {
      console.log(`${rel} unchanged: ${summary}`);
    } else {
      mkdirSync(dirname(CATALOG_PATH), { recursive: true });
      writeFileSync(CATALOG_PATH, text);
      console.log(`wrote ${rel}: ${summary}`);
    }
  }
} finally {
  await runner.close();
  await server.close();
}
process.exit(code);
