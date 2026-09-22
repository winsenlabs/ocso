import { Inject, Injectable } from '@nestjs/common';
import { CopilotService, DeliveryService, MediaMaterializer, SummaryService, TurnProcessor } from '@ocso/agent-runtime';
import { AlertDeliveryService, WebhookDeliveryService, isAlertDeliveryRetryable, isWebhookRetryable, type AlertDeliverJob, type WorkerSettings } from '@ocso/application';
import type { Logger } from '@ocso/observability';
import { ocsoMetrics } from '@ocso/observability';
import { backoffSeconds, type HandlerResult, type QueueAdapter, type QueueSubscription } from '@ocso/queue';
import { ALERT_DELIVERY_ATTEMPTS, WEBHOOK_DELIVERY_ATTEMPTS } from '../alerts/alerts.module.js';
import { LOGGER, QUEUE } from '../infrastructure/tokens.js';

/**
 * Queue consumers owned by this worker. Turn concurrency = conversations per
 * worker (docs/10 §5); resubscribed when the Tech Admin changes it.
 */
@Injectable()
export class ConsumersService {
  private subs: QueueSubscription[] = [];
  private turnConcurrency = 0;
  private turnSub: QueueSubscription | null = null;

  constructor(
    @Inject(QUEUE) private readonly queue: QueueAdapter,
    @Inject(TurnProcessor) private readonly turns: TurnProcessor,
    @Inject(DeliveryService) private readonly delivery: DeliveryService,
    @Inject(MediaMaterializer) private readonly media: MediaMaterializer,
    @Inject(SummaryService) private readonly summaries: SummaryService,
    @Inject(AlertDeliveryService) private readonly alertDelivery: AlertDeliveryService,
    @Inject(CopilotService) private readonly copilot: CopilotService,
    @Inject(WebhookDeliveryService) private readonly webhooks: WebhookDeliveryService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  start(settings: WorkerSettings): void {
    this.applyTurnSettings(settings);
    this.subs.push(
      this.queue.consume<{ interactionId: string }>('channel.deliver', async (m) => this.measure('channel.deliver', async () => {
        const r = await this.delivery.deliver(m.payload.interactionId, m.id);
        if (r.kind === 'retry') return { kind: 'retry', delaySeconds: Math.min(300, 5 * 2 ** m.attempt), reason: r.reason };
        return { kind: 'ack' };
      }), { concurrency: 16, visibilityTimeoutSeconds: 60, maxAttempts: 8 }),
      this.queue.consume<{ interactionId: string; partIdx: number }>('media.fetch', async (m) => this.measure('media.fetch', async () => {
        const r = await this.media.materialize(m.payload.interactionId, m.payload.partIdx);
        return r === 'retry' ? { kind: 'retry', delaySeconds: 10 * m.attempt, reason: 'media fetch' } : { kind: 'ack' };
      }), { concurrency: 8, visibilityTimeoutSeconds: 120, maxAttempts: 5 }),
      this.queue.consume<{ conversationId: string }>('conversation.summarize', async (m) => this.measure('conversation.summarize', async () => {
        await this.summaries.summarize(m.payload.conversationId, m.id);
        return { kind: 'ack' };
      }), { concurrency: 4, visibilityTimeoutSeconds: 120, maxAttempts: 3 }),
      // Best effort: a failed draft is not retried — the exec can request one on demand.
      this.queue.consume<{ conversationId: string; seq: number }>('copilot.suggest', async (m) => this.measure('copilot.suggest', async () => {
        await this.copilot.suggest(m.payload.conversationId, m.payload.seq, m.id).catch((err: unknown) => this.logger.warn({ err, conversationId: m.payload.conversationId }, 'copilot suggestion failed'));
        return { kind: 'ack' };
      }), { concurrency: 4, visibilityTimeoutSeconds: 120, maxAttempts: 1 }),
      this.queue.consume<{ deliveryId: string }>('webhook.deliver', async (m) => this.measure('webhook.deliver', async () => {
        try {
          await this.webhooks.deliver(m.payload.deliveryId);
          return { kind: 'ack' };
        } catch (err) {
          if (isWebhookRetryable(err)) return { kind: 'retry', delaySeconds: backoffSeconds(m.attempt, 5, 900), reason: 'webhook delivery' };
          throw err;
        }
      }), { concurrency: 8, visibilityTimeoutSeconds: 60, maxAttempts: WEBHOOK_DELIVERY_ATTEMPTS + 1 }),
      this.queue.consume<AlertDeliverJob>('alert.deliver', async (m) => this.measure('alert.deliver', async () => {
        try {
          await this.alertDelivery.deliver(m.payload.deliveryId);
          return { kind: 'ack' };
        } catch (err) {
          if (isAlertDeliveryRetryable(err)) return { kind: 'retry', delaySeconds: backoffSeconds(m.attempt, 5), reason: 'alert delivery' };
          throw err;
        }
      }), { concurrency: 4, visibilityTimeoutSeconds: 60, maxAttempts: ALERT_DELIVERY_ATTEMPTS + 1 }),
    );
  }

  /** (Re)subscribe the turn consumer when concurrency or timeout changes. */
  applyTurnSettings(settings: WorkerSettings): void {
    if (this.turnSub && this.turnConcurrency === settings.conversationsPerWorker) return;
    const previous = this.turnSub;
    this.turnConcurrency = settings.conversationsPerWorker;
    this.turnSub = this.queue.consume<{ conversationId: string }>(
      'conversation.turn',
      (m) => this.measure('conversation.turn', () => this.turns.handle(m)),
      { concurrency: settings.conversationsPerWorker, visibilityTimeoutSeconds: settings.turnTimeoutSeconds + 30, maxAttempts: 5, pollIntervalMs: 250 },
    );
    if (previous) void previous.stop();
    this.logger.info({ concurrency: settings.conversationsPerWorker }, 'turn consumer configured');
  }

  get inFlightTurns(): number {
    return this.turnSub?.inFlight ?? 0;
  }

  async stop(): Promise<void> {
    await Promise.all([...this.subs, ...(this.turnSub ? [this.turnSub] : [])].map((s) => s.stop()));
    this.subs = [];
    this.turnSub = null;
  }

  private async measure(topic: string, fn: () => Promise<HandlerResult>): Promise<HandlerResult> {
    try {
      const result = await fn();
      ocsoMetrics().queueJobs.add(1, { topic, outcome: result.kind });
      return result;
    } catch (err) {
      ocsoMetrics().queueJobs.add(1, { topic, outcome: 'error' });
      this.logger.error({ err, topic }, 'job failed');
      throw err;
    }
  }
}
