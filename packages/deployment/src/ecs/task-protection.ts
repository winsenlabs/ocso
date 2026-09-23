import { silentLogger, type DeploymentLogger, type TaskProtection } from '../contract.js';

export interface EcsAgentTaskProtectionOptions {
  /** `ECS_AGENT_URI`, injected into every ECS task by the agent. */
  agentUri: string;
  logger?: DeploymentLogger | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
}

/** Room for a turn that starts just before a refresh decision plus agent/API latency. */
const REFRESH_MARGIN_MS = 60_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const MAX_EXPIRY_MINUTES = 2_880;

/**
 * Expiry covers two full turns plus two minutes, so a protection refreshed
 * whenever less than one turn (+ margin) remains can never lapse under a
 * running turn, yet a crashed process stops blocking scale-in within minutes.
 */
export function protectionExpiryMinutes(turnTimeoutSeconds: number): number {
  return Math.min(MAX_EXPIRY_MINUTES, Math.max(1, Math.ceil((2 * turnTimeoutSeconds + 120) / 60)));
}

/**
 * ECS task scale-in protection through the agent endpoint
 * (`PUT $ECS_AGENT_URI/task-protection/v1/state`), held only while at least
 * one turn runs (research/05 §2). Updates are serialized and computed from
 * the holder count at send time, so bursts collapse into one call and an
 * enable can never land after the matching disable.
 */
export class EcsAgentTaskProtection implements TaskProtection {
  readonly mode = 'ecs-agent' as const;
  private count = 0;
  private enabled = false;
  private expiresAt = 0;
  private turnTimeoutSeconds = 90;
  private chain: Promise<void> = Promise.resolve();
  private lastFailureLog = -Infinity;
  private readonly logger: DeploymentLogger;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly url: string;

  constructor(private readonly options: EcsAgentTaskProtectionOptions) {
    this.logger = options.logger ?? silentLogger;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.url = `${options.agentUri.replace(/\/+$/, '')}/task-protection/v1/state`;
  }

  get holders(): number {
    return this.count;
  }

  async around<T>(fn: () => Promise<T>, options: { turnTimeoutSeconds: number }): Promise<T> {
    this.turnTimeoutSeconds = options.turnTimeoutSeconds;
    this.count++;
    this.schedule();
    try {
      return await fn();
    } finally {
      this.count--;
      this.schedule();
    }
  }

  settled(): Promise<void> {
    return this.chain;
  }

  private schedule(): void {
    this.chain = this.chain.then(() => this.sync()).catch(() => {});
  }

  /** Never rejects: protection is best effort and must not affect turns. */
  private async sync(): Promise<void> {
    if (this.count > 0) {
      const remaining = this.expiresAt - this.now();
      if (this.enabled && remaining >= this.turnTimeoutSeconds * 1000 + REFRESH_MARGIN_MS) return;
      const minutes = protectionExpiryMinutes(this.turnTimeoutSeconds);
      const sentAt = this.now();
      if (await this.put({ ProtectionEnabled: true, ExpiresInMinutes: minutes })) {
        this.enabled = true;
        this.expiresAt = sentAt + minutes * 60_000;
      }
    } else if (this.enabled) {
      if (await this.put({ ProtectionEnabled: false })) {
        this.enabled = false;
        this.expiresAt = 0;
      }
    }
  }

  private async put(body: { ProtectionEnabled: boolean; ExpiresInMinutes?: number }): Promise<boolean> {
    try {
      const res = await this.fetchFn(this.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
      });
      const payload = (await res.json().catch(() => null)) as { failure?: { Reason?: string }; error?: { Code?: string; Message?: string } } | null;
      if (!res.ok || payload?.failure || payload?.error) {
        const reason = payload?.failure?.Reason ?? payload?.error?.Code ?? payload?.error?.Message ?? `HTTP ${res.status}`;
        this.logFailure(body.ProtectionEnabled, reason);
        return false;
      }
      return true;
    } catch (err) {
      this.logFailure(body.ProtectionEnabled, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      return false;
    }
  }

  private logFailure(enable: boolean, reason: string): void {
    const now = this.now();
    if (now - this.lastFailureLog < FAILURE_LOG_INTERVAL_MS) return;
    this.lastFailureLog = now;
    this.logger.warn({ enable, reason: reason.slice(0, 200) }, 'task scale-in protection update failed');
  }
}
