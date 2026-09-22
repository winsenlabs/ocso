import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
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

/** SQS allows at most 15 minutes of delay; longer delays go through the scheduled-jobs relay. */
export const SQS_MAX_DELAY_SECONDS = 900;

export interface SqsQueueOptions {
  /** Topic → SQS Standard queue URL (each with its own DLQ redrive policy). */
  queueUrls: Readonly<Record<string, string>>;
  /** Called for delays beyond 900 s (persisted relay in Postgres, ADR-008). */
  scheduleLongDelay?: ((topic: Topic, payload: unknown, options: PublishOptions) => Promise<void>) | undefined;
  waitTimeSeconds?: number | undefined;
}

interface Envelope {
  topic: Topic;
  payload: unknown;
  groupKey: string | null;
  enqueuedAt: string;
}

/**
 * SQS Standard driver (ADR-008): at-least-once, unordered; ordering and
 * one-responder-per-conversation come from Postgres leases, not from SQS.
 */
export class SqsQueue implements QueueAdapter {
  readonly driver = 'sqs' as const;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsQueueOptions,
  ) {}

  private urlFor(topic: Topic): string {
    const url = this.options.queueUrls[topic];
    if (!url) throw new Error(`no SQS queue configured for topic ${topic}`);
    return url;
  }

  async publish<T>(topic: Topic, payload: T, opts: PublishOptions = {}): Promise<void> {
    const delay = opts.delaySeconds ?? 0;
    if (delay > SQS_MAX_DELAY_SECONDS) {
      if (!this.options.scheduleLongDelay) throw new Error('long delays require a scheduled-jobs relay');
      await this.options.scheduleLongDelay(topic, payload, opts);
      return;
    }
    const envelope: Envelope = { topic, payload, groupKey: opts.groupKey ?? null, enqueuedAt: new Date().toISOString() };
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urlFor(topic),
        MessageBody: JSON.stringify(envelope),
        DelaySeconds: delay,
        // Standard queues accept MessageGroupId for fair queuing across conversations.
        ...(opts.groupKey ? { MessageGroupId: opts.groupKey } : {}),
      }),
    );
  }

  consume<T>(topic: Topic, handler: MessageHandler<T>, options: ConsumeOptions): QueueSubscription {
    const loop = new ConsumerLoop<T>(this.source<T>(topic, options), handler, { ...options, pollIntervalMs: 0 });
    loop.start();
    return {
      stop: () => loop.stop(),
      get inFlight() {
        return loop.inFlight;
      },
    };
  }

  async stats(topic: Topic): Promise<QueueStats> {
    const out = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.urlFor(topic),
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const attrs = out.Attributes ?? {};
    // Oldest age is a CloudWatch metric (ApproximateAgeOfOldestMessage), read by the telemetry module.
    return {
      depth: Number(attrs.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0),
      dead: 0,
      oldestAgeSeconds: null,
    };
  }

  private source<T>(topic: Topic, options: ConsumeOptions): MessageSource<T> {
    const url = this.urlFor(topic);
    const client = this.client;
    const wait = this.options.waitTimeSeconds ?? 20;
    return {
      async claim(max): Promise<Array<ClaimedMessage<T>>> {
        const out = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: Math.min(10, Math.max(1, max)),
            WaitTimeSeconds: wait,
            VisibilityTimeout: options.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        return (out.Messages ?? []).map((m) => {
          const env = JSON.parse(m.Body ?? '{}') as Envelope;
          return {
            receipt: m.ReceiptHandle!,
            message: {
              id: m.MessageId!,
              topic: env.topic,
              payload: env.payload as T,
              groupKey: env.groupKey,
              attempt: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
              enqueuedAt: new Date(env.enqueuedAt),
            },
          };
        });
      },
      async ack(receipt) {
        await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: receipt }));
      },
      async release(receipt, delaySeconds, _error, _countAttempt, dead) {
        // Dead messages are left to the redrive policy (maxReceiveCount) → DLQ.
        await client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: url,
            ReceiptHandle: receipt,
            VisibilityTimeout: dead ? 0 : Math.min(43_200, Math.max(0, delaySeconds)),
          }),
        );
      },
      async extend(receipt, seconds) {
        await client.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: receipt, VisibilityTimeout: seconds }),
        );
      },
    };
  }
}
