import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ChangesQuery, LatencyQuery, SystemOverviewService } from '@ocso/application';
import { Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

/**
 * Tech admin control center (design/03, docs/archive/specs/11 §2). Technical
 * telemetry only — ids, counts, timings, tokens; never conversation content.
 */
@Controller('v1/telemetry')
export class TelemetryController {
  constructor(@Inject(SystemOverviewService) private readonly telemetry: SystemOverviewService) {}

  /** Status bar, service chips, 30-day uptime and tiles. */
  @Capability({ name: 'telemetry.get_overview', summary: 'System status: services, 30-day uptime and key tiles.', tags: ['status', 'uptime'] })
  @Get('overview')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  overview(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.overview(principal);
  }

  /** Per-minute p95 turn latency / TTFT with provider incident markers and slowest-turn trace links. */
  @Capability({ name: 'telemetry.get_latency', summary: 'Turn latency (p95) and time to first token per minute, with provider incidents.', tags: ['slow', 'performance'] })
  @Get('latency')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  latency(@CurrentPrincipal() principal: Principal, @Query({ schema: LatencyQuery }) q: LatencyQuery) {
    return this.telemetry.latency(principal, q.minutes);
  }

  /** Token and prompt-cache usage today, by model profile, with cost. */
  @Capability({ name: 'telemetry.get_usage', summary: 'Token and prompt-cache usage today by model profile, with cost.', tags: ['tokens', 'cost'] })
  @Get('usage')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  usage(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.usage(principal);
  }

  /** Worker instances, lease accounting and worker configuration. */
  @Capability({ name: 'telemetry.get_workers', summary: 'Worker instances, lease accounting and worker configuration.', tags: ['worker', 'capacity'] })
  @Get('workers')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  workers(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.workers(principal);
  }

  @Capability({ name: 'telemetry.get_providers', summary: 'Model provider health and errors.', tags: ['provider', 'errors'] })
  @Get('providers')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  providers(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.providers(principal);
  }

  @Capability({ name: 'telemetry.get_mcp', summary: 'MCP connection health and tool failure rates.', tags: ['mcp', 'tool', 'errors'] })
  @Get('mcp')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  mcp(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.mcp(principal);
  }

  /** Recent privileged (platform) configuration changes from the audit log. */
  @Capability({ name: 'telemetry.list_changes', summary: 'Recent platform configuration changes from the audit log.', tags: ['change', 'recent'] })
  @Get('changes')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  changes(@CurrentPrincipal() principal: Principal, @Query({ schema: ChangesQuery }) q: ChangesQuery) {
    return this.telemetry.changes(principal, q.limit);
  }
}
