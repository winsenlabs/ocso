import { Body, Controller, Get, Inject, Patch } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { DeploymentSettingsInput, SettingsService, WorkerSettingsInput, type ActorContext } from '@ocso/application';
import { Actor, Authenticated, RequirePermission } from '../../common/decorators.js';

@Controller('v1/settings')
export class SettingsController {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  @Get('deployment')
  @Authenticated()
  deployment() {
    return this.settings.deployment();
  }

  @Patch('deployment')
  @RequirePermission(Permission.DEPLOYMENT_SETTINGS_MANAGE)
  updateDeployment(@Actor() actor: ActorContext, @Body({ schema: DeploymentSettingsInput }) body: DeploymentSettingsInput) {
    return this.settings.updateDeployment(actor, body);
  }

  @Get('workers')
  @RequirePermission(Permission.SYSTEM_READ)
  workers() {
    return this.settings.workers();
  }

  @Patch('workers')
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  updateWorkers(@Actor() actor: ActorContext, @Body({ schema: WorkerSettingsInput }) body: WorkerSettingsInput) {
    return this.settings.updateWorkers(actor, body);
  }
}
