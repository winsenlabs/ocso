import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CatalogSnapshotSchema, type CatalogSnapshot } from './types.js';

/**
 * Offline fallback (ADR-027): a normalized snapshot of both catalogs shipped
 * in the package (`catalog/vendored-snapshot.json`, listed in `files`).
 * Regenerate with `node scripts/refresh-model-catalog.mjs` (after building
 * @ocso/model-providers). Used until the first successful refresh is stored
 * in the database, and whenever the stored copy is unreadable. A missing or
 * corrupt file yields no snapshots (never an exception).
 */

export const VENDORED_FILE = new URL('../../catalog/vendored-snapshot.json', import.meta.url);

const VendoredFile = z.object({ generatedAt: z.string(), snapshots: z.array(CatalogSnapshotSchema) });

let cached: CatalogSnapshot[] | undefined;

export function vendoredSnapshots(): CatalogSnapshot[] {
  if (cached) return cached;
  try {
    cached = VendoredFile.parse(JSON.parse(readFileSync(VENDORED_FILE, 'utf8'))).snapshots;
  } catch {
    cached = [];
  }
  return cached;
}
