import { Controller, Get, Inject } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { describePlugins, type OcsoPlugin, type PluginInfo } from '@ocso/bootstrap';
import type { ApiEnv } from '@ocso/config';
import { Capability, RequirePermission } from '../../common/decorators.js';
import { ENV, PLUGINS } from '../../infrastructure/tokens.js';

/**
 * The plugins this deployment runs (docs/plugins/installing.md): the ones
 * compiled into OCSO (first-party, at the OCSO version) and the ones the
 * operator installed through OCSO_PLUGINS (at their pinned version), with
 * the kinds each contributes. Fixed for the life of the process.
 */
@Controller('v1/system')
export class PluginsController {
  private readonly plugins: PluginInfo[];

  constructor(@Inject(PLUGINS) plugins: readonly OcsoPlugin[], @Inject(ENV) env: ApiEnv) {
    this.plugins = describePlugins(plugins, env.APP_VERSION);
  }

  @Capability({ name: 'system.list_plugins', summary: 'List the plugins compiled into this deployment.', tags: ['plugin'] })
  @Get('plugins')
  @RequirePermission(Permission.SYSTEM_READ)
  list(): PluginInfo[] {
    return this.plugins;
  }
}
