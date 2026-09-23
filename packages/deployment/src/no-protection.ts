import type { TaskProtection } from './contract.js';

/** Platforms without scale-in (Compose) or without an ECS agent: just count holders. */
export class NoTaskProtection implements TaskProtection {
  readonly mode = 'none' as const;
  private count = 0;

  get holders(): number {
    return this.count;
  }

  async around<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    try {
      return await fn();
    } finally {
      this.count--;
    }
  }

  async settled(): Promise<void> {}
}
