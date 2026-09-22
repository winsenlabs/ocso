/**
 * QueueAdapter contract (docs/10 §4, ADR-008). Messages are work signals; all
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
  readonly driver: 'postgres' | 'sqs' | 'memory';
  publish<T>(topic: Topic, payload: T, options?: PublishOptions): Promise<void>;
  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription;
  stats(topic: Topic): Promise<QueueStats>;
}

/** Exponential backoff with full jitter, capped. */
export function backoffSeconds(attempt: number, baseSeconds = 2, capSeconds = 300): number {
  const exp = Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(Math.random() * exp));
}
