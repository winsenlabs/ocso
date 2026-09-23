import { Module } from '@nestjs/common';
import { WorkerAlertsModule } from './alerts/alerts.module.js';
import { WorkerApprovalsModule } from './approvals/approvals.module.js';
import { WorkerAuditModule } from './audit/audit.module.js';
import { WorkerExceptionsModule } from './exceptions/exceptions.module.js';
import { ConsumersService } from './consumers/consumers.service.js';
import { WorkerInfrastructureModule } from './infrastructure/infrastructure.module.js';
import { WorkerLifecycleService } from './runtime/lifecycle.service.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { WorkerScalingModule } from './scaling/scaling.module.js';

/** Worker process: executes turns and background jobs; no HTTP API (build rule §18). */
@Module({
  imports: [WorkerInfrastructureModule, RuntimeModule, WorkerAlertsModule, WorkerScalingModule, WorkerApprovalsModule, WorkerAuditModule, WorkerExceptionsModule],
  providers: [ConsumersService, SchedulerService, WorkerLifecycleService],
})
export class WorkerModule {}
