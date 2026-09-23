import type { HistoryEntry, CustomerContext, SummaryContext } from '@ocso/prompt-compiler';
import type { AgentToolCatalog } from '../tools/catalog.js';

/**
 * Derived, never authoritative (docs/05 §4). Each part records the version it
 * was built from; validation compares against current PostgreSQL state and
 * cache generations before every use.
 */
export interface CachedAgentPrefix {
  promptVersionId: string;
  components: Record<string, string>;
  catalog: AgentToolCatalog;
}

export interface ConversationCacheEntry {
  generations: Record<string, number>;
  agent: CachedAgentPrefix | null;
  customer: { contextVersion: number; context: CustomerContext } | null;
  summary: { version: number; context: SummaryContext | null } | null;
  /** Answered history (recent window) through `historyThroughSeq`. */
  history: HistoryEntry[];
  historyThroughSeq: number;
  lastUsed: number;
}

export type CacheLayer = 'HOT' | 'SNAPSHOT' | 'COLD';

/** Bounded in-worker LRU for leased conversations (hot tier). */
export class HotContextCache {
  private readonly entries = new Map<string, ConversationCacheEntry>();

  constructor(private readonly maxEntries = 500) {}

  get(conversationId: string): ConversationCacheEntry | undefined {
    const entry = this.entries.get(conversationId);
    if (entry) {
      entry.lastUsed = Date.now();
      this.entries.delete(conversationId);
      this.entries.set(conversationId, entry);
    }
    return entry;
  }

  set(conversationId: string, entry: ConversationCacheEntry): void {
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  drop(conversationId: string): void {
    this.entries.delete(conversationId);
  }

  /** Invalidate every entry whose snapshot depended on a scope (event-driven). */
  dropScope(scope: string): number {
    let dropped = 0;
    for (const [id, entry] of this.entries) {
      if (scope in entry.generations || scope === 'global' || scope === 'policy') {
        this.entries.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface CacheStats {
  hot: number;
  snapshot: number;
  cold: number;
  invalidations: number;
}
