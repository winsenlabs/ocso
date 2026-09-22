import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { EVENTS_CHANNEL, ScalingService, SettingsService, type WorkerSettings } from '@ocso/application';
import { HotContextCache, LeaseManager, TurnProcessor } from '@ocso/agent-runtime';
import type { PgListener } from '@ocso/bootstrap';
import { virtualAgents, conversations, type Db } from '@ocso/db';
import type { Logger } from '@ocso/observability';
import { ConsumersService } from '../consumers/consumers.service.js';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import { DB, LISTENER, LOGGER } from '../infrastructure/tokens.js';
import { WorkerRegistryService, type WorkerStatus } from './worker-registry.service.js';

/**
 * Worker lifecycle: register → start consumers + scheduler → heartbeat (also
 * extends busy leases and reloads worker settings) → graceful drain on SIGTERM.
 */
@Injectable()
export class WorkerLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private status: WorkerStatus = 'STARTING';
  private settings: WorkerSettings | null = null;

  constructor(
    @Inject(WorkerRegistryService) private readonly registry: WorkerRegistryService,
    @Inject(SettingsService) private readonly settingsService: SettingsService,
    @Inject(ConsumersService) private readonly consumers: ConsumersService,
    @Inject(SchedulerService) private readonly scheduler: SchedulerService,
    @Inject(LeaseManager) private readonly leases: LeaseManager,
    @Inject(TurnProcessor) private readonly turns: TurnProcessor,
    @Inject(HotContextCache) private readonly hot: HotContextCache,
    @Inject(LISTENER) private readonly listener: PgListener,
    @Inject(DB) private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ScalingService) private readonly scaling: ScalingService,
  ) {}

  get ready(): boolean {
    return this.status === 'HEALTHY';
  }

  async onApplicationBootstrap(): Promise<void> {
    this.settings = await this.settingsService.workers();
    this.applyTiming(this.settings);
    await this.registry.register(this.settings.conversationsPerWorker);
    this.listener.on((channel, payload) => void this.onEvent(channel, payload));
    this.consumers.start(this.settings);
    this.scheduler.start();
    this.status = 'HEALTHY';
    await this.beat();
    this.heartbeatTimer = setInterval(() => void this.beat(), this.settings.heartbeatIntervalSeconds * 1000);
    this.logger.info({ capacity: this.settings.conversationsPerWorker }, 'worker started');
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'worker draining');
    this.status = 'DRAINING';
    await this.beat().catch(() => {});
    await this.scheduler.stop();
    await this.consumers.stop();
    await this.leases.releaseAll().catch(() => {});
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.status = 'STOPPED';
    await this.beat().catch(() => {});
  }

  private async beat(): Promise<void> {
    try {
      const active = this.turns.activeConversations();
      const lost = await this.leases.heartbeat(active);
      for (const id of lost) this.hot.drop(id);
      const next = await this.settingsService.workers();
      if (this.settings && next.updatedAt.getTime() !== this.settings.updatedAt.getTime()) {
        this.applyTiming(next);
        if (this.status === 'HEALTHY') this.consumers.applyTurnSettings(next);
      }
      this.settings = next;
      await this.registry.heartbeat(this.status, next.conversationsPerWorker, await this.leases.held(), active.length);
    } catch (err) {
      this.logger.warn({ err }, 'heartbeat failed');
    }
  }

  private applyTiming(s: WorkerSettings): void {
    this.leases.setTiming({ leaseSeconds: s.leaseDurationSeconds, idleSeconds: s.idleLeaseSeconds });
  }

  /** Realtime events: cache invalidation and mid-turn cancellation (ADR-019). */
  private async onEvent(channel: string, payload: string): Promise<void> {
    if (channel !== EVENTS_CHANNEL) return;
    let event: { type?: string; conversationId?: string; payload?: { scope?: string; area?: string } };
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type === 'cache.invalidated' && event.payload?.scope) {
      this.hot.dropScope(event.payload.scope);
    } else if (event.type === 'config.changed' && event.payload?.area === 'workers' && this.scheduler.isLeader) {
      // Only the leader applies scaling (ADR-023); others pick settings up on heartbeat.
      void this.scaling.reconcile('config_changed').catch((err: unknown) => this.logger.warn({ err }, 'scaling reconcile failed'));
    } else if (event.type === 'interaction.received' && event.conversationId && this.turns.activeConversations().includes(event.conversationId)) {
      const [row] = await this.db
        .select({ policy: virtualAgents.midTurnPolicy })
        .from(conversations)
        .innerJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId))
        .where(eq(conversations.id, event.conversationId));
      if (row?.policy === 'CANCEL_AND_RESTART' && this.turns.cancel(event.conversationId)) {
        this.logger.info({ conversationId: event.conversationId }, 'turn cancelled for newer customer message');
      }
    }
  }
}
