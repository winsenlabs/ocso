import { Module } from '@nestjs/common';
import { ScalingService } from '@ocso/application';
import { createDeploymentAdapter, type DriverRegistries } from '@ocso/bootstrap';
import type { WorkerEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { DeploymentAdapter } from '@ocso/deployment';
import type { Logger } from '@ocso/observability';
import type { QueueAdapter } from '@ocso/queue';
import { DB, DRIVERS, ENV, LOGGER, QUEUE } from '../infrastructure/tokens.js';

/** The deployment adapter the registered DEPLOYMENT_DRIVER builds (docs/13 §4). */
export const DEPLOYMENT_ADAPTER = Symbol('DEPLOYMENT_ADAPTER');
/** Turn-scoped scale-in protection for this process (ADR-023). */
export const TASK_PROTECTION = Symbol('TASK_PROTECTION');

/**
 * Worker scaling (ADR-023): the adapter, its task protection handle and the
 * ScalingService the scheduler leader drives (metrics every 60 s on ECS,
 * reconcile every 5 min and on `config.changed` for workers).
 */
@Module({
  providers: [
    {
      provide: DEPLOYMENT_ADAPTER,
      inject: [ENV, LOGGER, DRIVERS],
      useFactory: (env: WorkerEnv, logger: Logger, drivers: DriverRegistries) => createDeploymentAdapter(env, logger.child({ component: 'deployment' }), drivers),
    },
    { provide: TASK_PROTECTION, inject: [DEPLOYMENT_ADAPTER], useFactory: (adapter: DeploymentAdapter) => adapter.taskProtection() },
    {
      provide: ScalingService,
      inject: [DB, QUEUE, DEPLOYMENT_ADAPTER, LOGGER],
      useFactory: (db: Db, queue: QueueAdapter, adapter: DeploymentAdapter, logger: Logger) =>
        new ScalingService({ db, queue, adapter, logger: logger.child({ component: 'scaling' }) }),
    },
  ],
  exports: [DEPLOYMENT_ADAPTER, TASK_PROTECTION, ScalingService],
})
export class WorkerScalingModule {}
