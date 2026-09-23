import { Inject, Injectable } from '@nestjs/common';
import { ConversationInsightsService, CopilotService, DeliveryService, EvaluationService, MediaMaterializer, RouteProcessor, SummaryService, TurnProcessor } from '@ocso/agent-runtime';
import { AlertDeliveryService, WebhookDeliveryService, isAlertDeliveryRetryable, isWebhookRetryable, type AlertDeliverJob, type WorkerSettings } from '@ocso/application';
import type { Logger } from '@ocso/observability';
import { ocsoMetrics } from '@ocso/observability';
import { backoffSeconds, type HandlerResult, type QueueAdapter, type QueueSubscription } from '@ocso/queue';
import type { TaskProtection } from '@ocso/deployment';
import { ALERT_DELIVERY_ATTEMPTS, WEBHOOK_DELIVERY_ATTEMPTS } from '../alerts/alerts.module.js';
import { ApprovalsWorker } from '../approvals/approvals.module.js';
import { LOGGER, QUEUE } from '../infrastructure/tokens.js';
import { TASK_PROTECTION } from '../scaling/scaling.module.js';

/**
 * Queue consumers owned by this worker. Turn concurrency = conversations per
 * worker (docs/10 §5); resubscribed when the Tech admin changes it.
 */
@Injectable()
export class ConsumersService {
  private subs: QueueSubscription[] = [];
  private turnConcurrency = 0;
  private turnSub: QueueSubscription | null = null;
  private turnTimeoutSeconds = 90;

  constructor(
    @Inject(QUEUE) private readonly queue: QueueAdapter,
    @Inject(TurnProcessor) private readonly turns: TurnProcessor,
    @Inject(DeliveryService) private readonly delivery: DeliveryService,
    @Inject(MediaMaterializer) private readonly media: MediaMaterializer,
    @Inject(SummaryService) private readonly summaries: SummaryService,
    @Inject(AlertDeliveryService) private readonly alertDelivery: AlertDeliveryService,
    @Inject(CopilotService) private readonly copilot: CopilotService,
    @Inject(WebhookDeliveryService) private readonly webhooks: WebhookDeliveryService,
    @Inject(ConversationInsightsService) private readonly insights: ConversationInsightsService,
    @Inject(EvaluationService) private readonly evaluations: EvaluationService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(TASK_PROTECTION) private readonly protection: TaskProtection,
    @Inject(ApprovalsWorker) private readonly approvals: ApprovalsWorker,
    @Inject(RouteProcessor) private readonly routes: RouteProcessor,
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
      this.queue.consume<{ conversationId: string }>('conversation.insights', async (m) => this.measure('conversation.insights', async () => {
        await this.insights.analyze(m.payload.conversationId, m.id);
        return { kind: 'ack' };
      }), { concurrency: 2, visibilityTimeoutSeconds: 180, maxAttempts: 3 }),
      this.queue.consume<{ evaluationRunId: string }>('evaluation.run', async (m) => this.measure('evaluation.run', async () => {
        await this.evaluations.run(m.payload.evaluationRunId, m.id);
        return { kind: 'ack' };
      }), { concurrency: 1, visibilityTimeoutSeconds: 900, maxAttempts: 2 }),
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
      // Maker–checker: approval emails and deferred activations (PM/research/11b).
      ...this.approvals.consume(this.queue),
      // Routers (PM/research/11 §5.3): ask, classify, decide; the agent's turn is published on completion.
      this.queue.consume<{ conversationId: string }>('conversation.route', async (m) => this.measure('conversation.route', () => this.routes.handle(m)), {
        concurrency: 8,
        visibilityTimeoutSeconds: 120,
        maxAttempts: 5,
      }),
    );
  }

  /** (Re)subscribe the turn consumer when concurrency or timeout changes. */
  applyTurnSettings(settings: WorkerSettings): void {
    // The visibility timeout is fixed per subscription, so a timeout change also resubscribes.
    if (this.turnSub && this.turnConcurrency === settings.conversationsPerWorker && this.turnTimeoutSeconds === settings.turnTimeoutSeconds) return;
    this.turnTimeoutSeconds = settings.turnTimeoutSeconds;
    const previous = this.turnSub;
    this.turnConcurrency = settings.conversationsPerWorker;
    this.turnSub = this.queue.consume<{ conversationId: string }>(
      'conversation.turn',
      // ECS scale-in protection only while a turn runs (ADR-023); best effort, never fails the turn.
      (m) => this.measure('conversation.turn', () => this.protection.around(() => this.turns.handle(m), { turnTimeoutSeconds: this.turnTimeoutSeconds })),
      { concurrency: settings.conversationsPerWorker, visibilityTimeoutSeconds: settings.turnTimeoutSeconds + 30, maxAttempts: 5, pollIntervalMs: 250 },
    );
    if (previous) void previous.stop();
    this.logger.info({ concurrency: settings.conversationsPerWorker, turnTimeoutSeconds: settings.turnTimeoutSeconds }, 'turn consumer configured');
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
