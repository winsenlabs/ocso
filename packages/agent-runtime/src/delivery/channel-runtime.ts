import { eq } from 'drizzle-orm';
import { channels, type Db } from '@ocso/db';
import type { ChannelAdapter, ChannelRegistry, ChannelRuntimeConfig } from '@ocso/channels';
import type { SecretStore } from '@ocso/secrets';

/** Resolves a channel row + adapter + decrypted secrets for trusted worker code. */
export class ChannelRuntime {
  constructor(
    private readonly db: Db,
    private readonly registry: ChannelRegistry,
    private readonly secrets: SecretStore,
  ) {}

  async load(channelId: string): Promise<{ adapter: ChannelAdapter; config: ChannelRuntimeConfig; row: typeof channels.$inferSelect }> {
    const [row] = await this.db.select().from(channels).where(eq(channels.id, channelId));
    if (!row) throw new Error(`channel ${channelId} not found`);
    const adapter = this.registry.get(row.kind);
    const resolved = await Promise.all(Object.entries(row.secretRefs).map(async ([k, ref]) => [k, await this.secrets.resolve(ref)] as const));
    return {
      adapter,
      row,
      config: { id: row.id, kind: row.kind, name: row.name, settings: row.settings, secrets: Object.fromEntries(resolved) },
    };
  }
}
