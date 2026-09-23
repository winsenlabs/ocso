import { Controller, Get, Headers, Inject } from '@nestjs/common';
import type { Principal } from '@ocso/auth';
import { HomeService } from '@ocso/application';
import { Authenticated, Capability, CurrentPrincipal } from '../../common/decorators.js';

/**
 * Role-aware home (design/06, HOME contract). Any signed-in user; HomeService returns exactly
 * one role surface gated by permission (execs never get technical telemetry,
 * Tech admins never get conversation content), plus the ranked "needs you" list,
 * trend tiles, the service flow and the setup checklist (Heads, Leads, Tech) and
 * take next (Service).
 */
@Controller('v1/home')
export class HomeController {
  constructor(@Inject(HomeService) private readonly home: HomeService) {}

  @Capability({ name: 'analytics.get_home', summary: 'Your Home page summary: key numbers and what needs attention.', tags: ['home', 'dashboard', 'summary'] })
  @Get()
  @Authenticated()
  get(@CurrentPrincipal() principal: Principal, @Headers('cache-control') cacheControl?: string) {
    // Cached 15 s per user; `Cache-Control: no-cache` (e.g. right after the user acted) reads fresh.
    return this.home.home(principal, { fresh: /no-cache|no-store|max-age=0/i.test(cacheControl ?? '') });
  }
}
