import { randomUUID } from 'node:crypto';
import type {
  ConsumeOptions,
  MessageHandler,
  PublishOptions,
  QueueAdapter,
  QueueStats,
  QueueSubscription,
  Topic,
} from '../contract.js';
import { ConsumerLoop, type ClaimedMessage, type MessageSource } from '../consumer-loop.js';

interface Item {
  id: string;
  topic: Topic;
  payload: unknown;
  groupKey: string | null;
  dedupeKey: string | null;
  attempts: number;
  availableAt: number;
  lockedUntil: number | null;
  status: 'queued' | 'running' | 'dead';
  enqueuedAt: Date;
}

/** In-process queue for unit tests. Same semantics as the Postgres driver, no durability. */
export class MemoryQueue implements QueueAdapter {
  readonly driver = 'memory' as const;
  private readonly items = new Map<string, Item>();
  private readonly loops = new Set<ConsumerLoop<unknown>>();

  async publish<T>(topic: Topic, payload: T, opts: PublishOptions = {}): Promise<void> {
    if (opts.dedupeKey) {
      for (const item of this.items.values()) {
        if (item.topic === topic && item.dedupeKey === opts.dedupeKey && item.status !== 'dead') return;
      }
    }
    const id = randomUUID();
    this.items.set(id, {
      id,
      topic,
      payload,
      groupKey: opts.groupKey ?? null,
      dedupeKey: opts.dedupeKey ?? null,
      attempts: 0,
      availableAt: Date.now() + (opts.delaySeconds ?? 0) * 1000,
      lockedUntil: null,
      status: 'queued',
      enqueuedAt: new Date(),
    });
    for (const loop of this.loops) loop.wake();
  }

  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription {
    const loop = new ConsumerLoop<T>(this.source<T>(topic, options), handler, { pollIntervalMs: 20, ...options });
    this.loops.add(loop as ConsumerLoop<unknown>);
    loop.start();
    return {
      stop: async () => {
        this.loops.delete(loop as ConsumerLoop<unknown>);
        await loop.stop();
      },
      get inFlight() {
        return loop.inFlight;
      },
    };
  }

  async stats(topic: Topic): Promise<QueueStats> {
    const now = Date.now();
    const mine = [...this.items.values()].filter((i) => i.topic === topic);
    const ready = mine.filter((i) => i.status === 'queued' && i.availableAt <= now);
    const oldest = ready.reduce<number | null>((min, i) => Math.min(min ?? Infinity, i.enqueuedAt.getTime()), null);
    return {
      depth: ready.length,
      inFlight: mine.filter((i) => i.status === 'running').length,
      dead: mine.filter((i) => i.status === 'dead').length,
      oldestAgeSeconds: oldest === null ? null : (now - oldest) / 1000,
    };
  }

  /** Test helper: all items including completed-and-removed ones are not retained. */
  pending(topic?: Topic): number {
    return [...this.items.values()].filter((i) => i.status !== 'dead' && (!topic || i.topic === topic)).length;
  }

  private source<T>(topic: Topic, options: ConsumeOptions): MessageSource<T> {
    const items = this.items;
    return {
      async claim(max): Promise<Array<ClaimedMessage<T>>> {
        const now = Date.now();
        const claimed: Array<ClaimedMessage<T>> = [];
        for (const item of items.values()) {
          if (claimed.length >= max) break;
          const expired = item.status === 'running' && (item.lockedUntil ?? 0) < now;
          if (item.topic !== topic || !((item.status === 'queued' && item.availableAt <= now) || expired)) continue;
          item.status = 'running';
          item.attempts += 1;
          item.lockedUntil = now + options.visibilityTimeoutSeconds * 1000;
          claimed.push({
            receipt: item.id,
            message: {
              id: item.id,
              topic,
              payload: item.payload as T,
              groupKey: item.groupKey,
              attempt: item.attempts,
              enqueuedAt: item.enqueuedAt,
            },
          });
        }
        return claimed;
      },
      async ack(receipt) {
        items.delete(receipt);
      },
      async release(receipt, delaySeconds, _error, countAttempt, dead) {
        const item = items.get(receipt);
        if (!item) return;
        item.status = dead ? 'dead' : 'queued';
        item.availableAt = Date.now() + delaySeconds * 1000;
        item.lockedUntil = null;
        if (!countAttempt) item.attempts -= 1;
      },
      async extend(receipt, seconds) {
        const item = items.get(receipt);
        if (item) item.lockedUntil = Date.now() + seconds * 1000;
      },
    };
  }
}
