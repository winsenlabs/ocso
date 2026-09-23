import { Controller, Get, Header, Inject, Post } from '@nestjs/common';
import type { SecretStore } from '@ocso/secrets';
import { Permission } from '@ocso/auth';
import { CustomerClaimsIssuer, type ActorContext } from '@ocso/application';
import { Actor, Public, RequirePermission } from '../../common/decorators.js';
import { SECRET_STORE } from '../../infrastructure/tokens.js';

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

/** Secrets & credentials inventory (design/04): metadata only — values are never returned. */
@Controller('v1/secrets')
export class SecretsController {
  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  @Get()
  @RequirePermission(Permission.SECRETS_MANAGE)
  async list() {
    const items = await this.secrets.list();
    const soon = Date.now() + 14 * 24 * 3600_000;
    return items.map((s) => ({ ...s, state: s.expiresAt && Date.parse(s.expiresAt) < Date.now() ? 'expired' : s.expiresAt && Date.parse(s.expiresAt) < soon ? 'expiring' : 'ok' }));
  }
}
