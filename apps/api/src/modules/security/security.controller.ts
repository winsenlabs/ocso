import { Controller, Get, Header, Inject, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { CustomerClaimsIssuer, type ActorContext } from '@ocso/application';
import { Actor, Public, RequirePermission } from '../../common/decorators.js';

/** Public verification keys for tool servers that receive customer claims. */
@Controller('.well-known')
export class JwksController {
  constructor(@Inject(CustomerClaimsIssuer) private readonly claims: CustomerClaimsIssuer) {}

  @Get('jwks.json')
  @Public()
  @Header('Cache-Control', 'public, max-age=300')
  jwks() {
    return this.claims.jwks();
  }
}

@Controller('v1/security/signing-keys')
export class SigningKeysController {
  constructor(@Inject(CustomerClaimsIssuer) private readonly claims: CustomerClaimsIssuer) {}

  @Get()
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  list() {
    return this.claims.listKeys();
  }

  @Post('rotate')
  @RequirePermission(Permission.SYSTEM_CONFIGURE)
  rotate(@Actor() actor: ActorContext) {
    return this.claims.rotate(actor);
  }
}
