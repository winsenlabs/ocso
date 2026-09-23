import { backoffSeconds, type ConsumeOptions, type MessageHandler, type QueueMessage } from './contract.js';

export interface ClaimedMessage<T> {
  /** Driver-specific handle (job id, SQS receipt handle). */
  receipt: string;
  message: QueueMessage<T>;
}

/** Driver primitives the shared consumer loop needs. */
export interface MessageSource<T> {
  claim(max: number): Promise<Array<ClaimedMessage<T>>>;
  ack(receipt: string): Promise<void>;
  release(receipt: string, delaySeconds: number, error: string | null, countAttempt: boolean, dead: boolean): Promise<void>;
  extend(receipt: string, seconds: number): Promise<void>;
}

/**
 * Shared polling consumer: bounded concurrency, automatic visibility
 * heartbeats while a handler runs, retry/defer/dead handling, graceful stop.
 */
export class ConsumerLoop<T> {
  private running = false;
  private active = 0;
  private wakeResolver: (() => void) | null = null;
  private readonly inflight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly source: MessageSource<T>,
    private readonly handler: MessageHandler<T>,
    private readonly options: ConsumeOptions,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  get inFlight(): number {
    return this.active;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  wake(): void {
    this.wakeResolver?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loopPromise;
    await Promise.allSettled([...this.inflight]);
  }

  private async loop(): Promise<void> {
    const pollMs = this.options.pollIntervalMs ?? 500;
    while (this.running) {
      const capacity = this.options.concurrency - this.active;
      let claimed: Array<ClaimedMessage<T>> = [];
      if (capacity > 0) {
        try {
          claimed = await this.source.claim(capacity);
        } catch (err) {
          this.onError(err);
        }
      }
      for (const item of claimed) this.dispatch(item);
      if (claimed.length === 0 || capacity - claimed.length <= 0) await this.sleep(pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeResolver = () => {
        this.wakeResolver = null;
        done();
      };
    });
  }

  private dispatch(item: ClaimedMessage<T>): void {
    this.active++;
    const task = this.process(item).finally(() => {
      this.active--;
      this.inflight.delete(task);
      this.wake();
    });
    this.inflight.add(task);
  }

  private async process({ receipt, message }: ClaimedMessage<T>): Promise<void> {
    const vis = this.options.visibilityTimeoutSeconds;
    const heartbeat = setInterval(() => {
      this.source.extend(receipt, vis).catch(this.onError);
    }, Math.max(1_000, (vis * 1_000) / 3));
    try {
      const result = await this.handler(message, {
        extendVisibility: (seconds) => this.source.extend(receipt, seconds),
        signal: this.abort.signal,
      });
      if (result.kind === 'ack') await this.source.ack(receipt);
      else if (result.kind === 'defer') await this.source.release(receipt, result.delaySeconds, null, false, false);
      else if (result.kind === 'dead') await this.source.release(receipt, 0, result.reason, true, true);
      else {
        const dead = message.attempt >= this.options.maxAttempts;
        await this.source.release(receipt, result.delaySeconds, result.reason, true, dead);
      }
    } catch (err) {
      this.onError(err);
      const dead = message.attempt >= this.options.maxAttempts;
      const reason = err instanceof Error ? err.message.slice(0, 500) : 'handler failed';
      await this.source.release(receipt, backoffSeconds(message.attempt), reason, true, dead).catch(this.onError);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
