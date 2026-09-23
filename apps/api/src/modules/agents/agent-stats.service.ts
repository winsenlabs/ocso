import { Inject, Injectable } from '@nestjs/common';
import { agentSummaries, type AgentSummary } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';

/** Short-lived cache so agent lists do not recompute KPIs on every request. */
@Injectable()
export class AgentStatsService {
  private cache: { at: number; value: Map<string, AgentSummary> } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async summaries(): Promise<Map<string, AgentSummary>> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.value;
    const value = await agentSummaries(this.db, 7);
    this.cache = { at: Date.now(), value };
    return value;
  }
}
