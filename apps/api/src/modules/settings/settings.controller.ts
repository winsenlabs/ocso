import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { DeploymentSettingsInput, ScalingStatusService, SettingsService, WorkerSettingsInput, describeRetention, type ActorContext } from '@ocso/application';
import { Actor, Authenticated, RequirePermission } from '../../common/decorators.js';

@Controller('v1/settings')
export class SettingsController {
  constructor(
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ScalingStatusService) private readonly scaling: ScalingStatusService,
  ) {}

  @Get('deployment')
  @Authenticated()
  deployment() {
    return this.settings.deployment();
  }

  /** Retention classes with defaults, floors and the effective values (docs/15 §8). */
  @Get('retention')
  @Authenticated()
  async retention() {
    return describeRetention((await this.settings.deployment()).retention);
  }

  @Patch('deployment')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updateDeployment(@Actor() actor: ActorContext, @Body({ schema: DeploymentSettingsInput }) body: DeploymentSettingsInput) {
    return this.settings.updateDeployment(actor, body);
  }

  /** Worker settings plus how far the deployment has applied them (ADR-023): applied / advisory / failed / pending. */
  @Get('workers')
  @RequirePermission(Permission.SYSTEM_READ)
  async workers() {
    const settings = await this.settings.workers();
    return { ...settings, scaling: await this.scaling.workers(undefined, settings) };
  }

  @Patch('workers')
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  async updateWorkers(@Actor() actor: ActorContext, @Body({ schema: WorkerSettingsInput }) body: WorkerSettingsInput) {
    const settings = await this.settings.updateWorkers(actor, body);
    return { ...settings, scaling: await this.scaling.workers(undefined, settings) };
  }

  /**
   * The worker service as the platform reports it (ECS desired/running/pending,
   * scalable target, policies, alarm), as last recorded by the worker leader —
   * the API itself holds no scaling permissions.
   */
  @Get('workers/deployment')
  @RequirePermission(Permission.SYSTEM_READ)
  workerDeployment() {
    return this.scaling.deployment();
  }
}
