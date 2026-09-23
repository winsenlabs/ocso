import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { ModelCatalogService, type ActorContext } from '@ocso/application';
import { Actor, RequireAnyPermission } from '../../common/decorators.js';

/** Open-source model catalog status and on-demand refresh (ADR-027). */
@Controller('v1/model-catalog')
export class ModelCatalogController {
  constructor(@Inject(ModelCatalogService) private readonly catalog: ModelCatalogService) {}

  @Get()
  @RequireAnyPermission(Permission.PROVIDERS_READ, Permission.PRICING_MANAGE)
  status(@Actor() actor: ActorContext) {
    return this.catalog.status(actor);
  }

  /** Download models.dev + LiteLLM now; catalog-origin prices follow (audited). */
  @Post('refresh')
  @HttpCode(200)
  @RequireAnyPermission(Permission.PRICING_MANAGE, Permission.PROVIDERS_MANAGE)
  refresh(@Actor() actor: ActorContext) {
    return this.catalog.refresh(actor);
  }
}
