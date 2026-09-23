#!/usr/bin/env node
// Regenerates the vendored model catalog snapshot (ADR-027) that OCSO uses
// offline, before the first successful catalog refresh is stored in the DB.
//
//   npx turbo run build --filter=@ocso/model-providers
//   node scripts/refresh-model-catalog.mjs
//
// Sources (both MIT): models.dev api.json (primary) and LiteLLM's
// model_prices_and_context_window.json (fallback). The output keeps only the
// providers OCSO maps, normalized (USD per 1M tokens), with a content hash per
// source. Set MODELS_DEV_FILE / LITELLM_FILE to use local copies instead of
// downloading. Review the diff before committing: prices change here.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalog = await import(new URL('../packages/model-providers/dist/catalog/index.js', import.meta.url).href).catch(() => {
  console.error('Build @ocso/model-providers first: npx turbo run build --filter=@ocso/model-providers');
  process.exit(1);
});

const FILES = { 'models.dev': process.env.MODELS_DEV_FILE, litellm: process.env.LITELLM_FILE };

async function load(source) {
  if (FILES[source]) return JSON.parse(await readFile(FILES[source], 'utf8'));
  const url = catalog.CATALOG_URLS[source];
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${source}: HTTP ${res.status} from ${url}`);
  return res.json();
}

const now = new Date();
const snapshots = [];
for (const source of catalog.CATALOG_SOURCES) {
  const snapshot = catalog.buildSnapshot(source, await load(source), now);
  const priced = snapshot.entries.filter((e) => e.price).length;
  console.log(`${source}: ${snapshot.entries.length} models (${priced} priced) · sha256 ${snapshot.contentHash.slice(0, 12)}…`);
  snapshots.push(snapshot);
}
const out = `${root}packages/model-providers/catalog/vendored-snapshot.json`;
await writeFile(out, `${JSON.stringify({ generatedAt: now.toISOString(), snapshots })}\n`);
console.log(`wrote ${out}`);
