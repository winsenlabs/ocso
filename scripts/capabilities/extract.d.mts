import type { CapabilityCatalog } from '../../packages/internal-agent/src/catalog/index.js';

export declare const REPO_ROOT: string;
export declare const CATALOG_PATH: string;
/** Signed-in web pages as `/agents/:id` patterns. */
export declare function appRoutes(): string[];
/** Build the catalog from the API; throws listing every unclassifiable route unless `lenient`. */
export declare function extractCatalog(options?: { lenient?: boolean }): Promise<CapabilityCatalog & { $comment: string; problems?: string[] }>;
/** Stable text of the catalog file. */
export declare function serializeCatalog(catalog: unknown): string;
