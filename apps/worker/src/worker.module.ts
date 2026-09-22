import { Module } from '@nestjs/common';
import { WorkerAlertsModule } from './alerts/alerts.module.js';
import { ConsumersService } from './consumers/consumers.service.js';
import { WorkerInfrastructureModule } from './infrastructure/infrastructure.module.js';
import { WorkerLifecycleService } from './runtime/lifecycle.service.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { SchedulerService } from './scheduler/scheduler.service.js';

/** Worker process: executes turns and background jobs; no HTTP API (build rule §18). */
@Module({
  imports: [WorkerInfrastructureModule, RuntimeModule, WorkerAlertsModule],
  providers: [ConsumersService, SchedulerService, WorkerLifecycleService],
})
export class WorkerModule {}
