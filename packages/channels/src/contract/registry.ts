import type { ChannelAdapter, ChannelKind } from './types.js';

/** Channel adapters are registered, never switched on (build rule §4). */
export class ChannelRegistry {
  private readonly adapters = new Map<ChannelKind, ChannelAdapter>();

  register(adapter: ChannelAdapter): this {
    if (this.adapters.has(adapter.kind)) throw new Error(`channel adapter ${adapter.kind} already registered`);
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  get(kind: ChannelKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no channel adapter registered for ${kind}`);
    return adapter;
  }

  has(kind: ChannelKind): boolean {
    return this.adapters.has(kind);
  }

  kinds(): ChannelKind[] {
    return [...this.adapters.keys()];
  }
}
