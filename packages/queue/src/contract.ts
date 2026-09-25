import type { SqlClient } from './sql.js';

/**
 * QueueAdapter contract (docs/archive/specs/10 §4, ADR-008). Messages are work signals; all
 * durable state lives in PostgreSQL. Business code depends only on this file.
 */

export const TOPICS = {
  CONVERSATION_TURN: 'conversation.turn',
  CHANNEL_DELIVER: 'channel.deliver',
  MEDIA_FETCH: 'media.fetch',
  CONVERSATION_SUMMARIZE: 'conversation.summarize',
  CONVERSATION_INSIGHTS: 'conversation.insights',
  COPILOT_SUGGEST: 'copilot.suggest',
  TOOL_EXECUTE_CONFIRMED: 'tool.execute_confirmed',
  ALERT_DELIVER: 'alert.deliver',
  WEBHOOK_DELIVER: 'webhook.deliver',
  EVALUATION_RUN: 'evaluation.run',
  /** Maker–checker notifications (in-app realtime is emitted in the decision's transaction; this sends email). */
  APPROVAL_NOTIFY: 'approval.notify',
  /** Finish a DEFERRED activation after approval (re-validates first). */
  APPROVAL_ACTIVATE: 'approval.activate',
  /** Routing (PM/research/11 §5.3): run a ROUTING conversation's router over new customer messages. */
  CONVERSATION_ROUTE: 'conversation.route',
} as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface PublishOptions {
  /** Ordering/affinity key, e.g. the conversation id. */
  groupKey?: string | undefined;
  /** Duplicate publishes with the same key (per topic) are dropped while pending. */
  dedupeKey?: string | undefined;
  delaySeconds?: number | undefined;
}

export interface QueueMessage<T = unknown> {
  id: string;
  topic: Topic;
  payload: T;
  groupKey: string | null;
  /** 1 on first delivery. */
  attempt: number;
  enqueuedAt: Date;
}

export type HandlerResult =
  | { kind: 'ack' }
  /** Failed attempt: redeliver after a delay (counts toward maxAttempts). */
  | { kind: 'retry'; delaySeconds: number; reason: string }
  /** Not failed, just not now (e.g. conversation busy on another worker). Does not count as an attempt. */
  | { kind: 'defer'; delaySeconds: number }
  | { kind: 'dead'; reason: string };

export interface HandlerContext {
  /** Extend the in-flight window (heartbeat for long turns). */
  extendVisibility(seconds: number): Promise<void>;
  signal: AbortSignal;
}

export type MessageHandler<T> = (message: QueueMessage<T>, ctx: HandlerContext) => Promise<HandlerResult>;

export interface ConsumeOptions {
  concurrency: number;
  visibilityTimeoutSeconds: number;
  maxAttempts: number;
  /** Idle poll interval when no messages are available. */
  pollIntervalMs?: number | undefined;
}

export interface QueueSubscription {
  /** Stop claiming new messages and wait for in-flight handlers. */
  stop(): Promise<void>;
  readonly inFlight: number;
}

export interface QueueStats {
  depth: number;
  inFlight: number;
  dead: number;
  oldestAgeSeconds: number | null;
}

export interface QueueAdapter {
  /** Name of the driver that built it (QUEUE_DRIVER); display and logs only. */
  readonly driver: string;
  /** True when messages live in OCSO's PostgreSQL `jobs` table, so SQL may read the queue directly. */
  readonly inDatabase: boolean;
  /**
   * False when stats() cannot tell the oldest message's age (SQS exposes it
   * only as a CloudWatch metric): `oldestAgeSeconds: null` then means
   * "unknown", not "nothing waiting".
   */
  readonly reportsOldestAge: boolean;
  publish<T>(topic: Topic, payload: T, options?: PublishOptions): Promise<void>;
  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription;
  stats(topic: Topic): Promise<QueueStats>;
}

/** Wake-up hook: PgQueue consumers poll less when publishers notify (pg LISTEN/NOTIFY). */
export interface QueueNotifier {
  notify(topic: Topic): Promise<void>;
  onNotify(listener: (topic: Topic) => void): () => void;
}

/** What the composition root hands a queue driver besides the environment. */
export interface QueueDriverDeps {
  /** The process's PostgreSQL pool (for drivers that keep messages in the database). */
  sql: SqlClient;
  /** Stable id of this process (claims, affinity). */
  workerId: string;
  notifier?: QueueNotifier | undefined;
}

/**
 * A queue driver: registered by name, selected by QUEUE_DRIVER. `check` lists
 * missing settings (start-up fails naming every one); `create` builds the
 * process-wide adapter.
 */
export interface QueueDriverDefinition<Env = Readonly<Record<string, unknown>>> {
  /** QUEUE_DRIVER value that selects this driver, e.g. `sqs`. */
  readonly name: string;
  readonly check?: ((env: Env) => readonly string[]) | undefined;
  readonly create: (env: Env, deps: QueueDriverDeps) => QueueAdapter;
}

/** Exponential backoff with full jitter, capped. */
export function backoffSeconds(attempt: number, baseSeconds = 2, capSeconds = 300): number {
  const exp = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(Math.random() * exp));
}
