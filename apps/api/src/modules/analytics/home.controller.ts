import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@ocso/auth';
import { HomeService } from '@ocso/application';
import { Authenticated, CurrentPrincipal } from '../../common/decorators.js';

/**
 * Role-aware home (design/06). Any signed-in user; HomeService returns exactly
 * one role surface gated by permission (execs never get technical telemetry,
 * Tech admins never get conversation content).
 */
@Controller('v1/home')
export class HomeController {
  constructor(@Inject(HomeService) private readonly home: HomeService) {}

  @Get()
  @Authenticated()
  get(@CurrentPrincipal() principal: Principal) {
    return this.home.home(principal);
  }
}
