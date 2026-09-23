import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { ChangesQuery, LatencyQuery, SystemOverviewService } from '@ocso/application';
import { CurrentPrincipal, RequirePermission } from '../../common/decorators.js';

/**
 * Tech admin control center (design/03, docs/11 §2). Technical
 * telemetry only — ids, counts, timings, tokens; never conversation content.
 */
@Controller('v1/telemetry')
export class TelemetryController {
  constructor(@Inject(SystemOverviewService) private readonly telemetry: SystemOverviewService) {}

  /** Status bar, service chips, 30-day uptime and tiles. */
  @Get('overview')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  overview(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.overview(principal);
  }

  /** Per-minute p95 turn latency / TTFT with provider incident markers and slowest-turn trace links. */
  @Get('latency')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  latency(@CurrentPrincipal() principal: Principal, @Query({ schema: LatencyQuery }) q: LatencyQuery) {
    return this.telemetry.latency(principal, q.minutes);
  }

  /** Token and prompt-cache usage today, by model profile, with cost. */
  @Get('usage')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  usage(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.usage(principal);
  }

  /** Worker instances, lease accounting and worker configuration. */
  @Get('workers')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  workers(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.workers(principal);
  }

  @Get('providers')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  providers(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.providers(principal);
  }

  @Get('mcp')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  mcp(@CurrentPrincipal() principal: Principal) {
    return this.telemetry.mcp(principal);
  }

  /** Recent privileged (platform) configuration changes from the audit log. */
  @Get('changes')
  @RequirePermission(Permission.TELEMETRY_TECHNICAL_READ)
  changes(@CurrentPrincipal() principal: Principal, @Query({ schema: ChangesQuery }) q: ChangesQuery) {
    return this.telemetry.changes(principal, q.limit);
  }
}
