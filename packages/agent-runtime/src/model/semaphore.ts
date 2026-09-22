import { DomainError } from '@ocso/domain';

/**
 * Provider concurrency limit (docs/10 §8): bounded in-flight requests per
 * provider per worker. Waiters queue with a timeout so overload becomes a
 * typed capacity error instead of a cascade.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly waitTimeoutMs = 30_000,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new DomainError('capacity', 'provider_concurrency_exhausted', 'Provider concurrency limit reached'));
      }, this.waitTimeoutMs);
      const grant = () => {
        clearTimeout(timer);
        this.active++;
        resolve();
      };
      this.waiters.push(grant);
    });
  }
}
