import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { ModelListService, ProviderInput, ProviderPatch, ProviderService, ProviderTestInput, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, RequirePermission } from '../../common/decorators.js';

/** `?refresh=true` bypasses the ten-minute listing cache (providers.manage, checked in the service). */
const ModelsQuery = z.object({ refresh: z.stringbool().default(false) });
type ModelsQuery = z.infer<typeof ModelsQuery>;

/** A test may be sent without a body; it then probes the configured/default model. */
const TestBody = ProviderTestInput.optional();
type TestBody = z.infer<typeof TestBody>;

/** Model providers (docs/06). Responses carry secret references, never credential values. */
@Controller('v1/model-providers')
export class ModelProvidersController {
  constructor(
    @Inject(ProviderService) private readonly providers: ProviderService,
    @Inject(ModelListService) private readonly models: ModelListService,
  ) {}

  @Get()
  @RequirePermission(Permission.PROVIDERS_READ)
  list(@Actor() actor: ActorContext) {
    return this.providers.list(actor);
  }

  /** Provider kinds available in this deployment, with form field descriptors. */
  @Get('kinds')
  @RequirePermission(Permission.PROVIDERS_READ)
  kinds(@Actor() actor: ActorContext) {
    return this.providers.kinds(actor);
  }

  @Get(':id')
  @RequirePermission(Permission.PROVIDERS_READ)
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.providers.get(actor, id);
  }

  /**
   * Models this provider offers (its own listing, or its configured deployments),
   * with catalog metadata and prices. Listing failures come back as `error`.
   */
  @Get(':id/models')
  @RequirePermission(Permission.PROVIDERS_READ)
  listModels(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Query({ schema: ModelsQuery }) q: ModelsQuery) {
    return this.models.list(actor, id, { refresh: q.refresh });
  }

  @Post()
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ProviderInput }) body: ProviderInput) {
    return this.providers.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: ProviderPatch }) body: ProviderPatch) {
    return this.providers.update(actor, id, body);
  }

  /** "Test connection": health probe plus a tiny generation; updates the provider's health fields. */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  test(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: TestBody }) body: TestBody) {
    return this.providers.test(actor, id, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.PROVIDERS_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.providers.delete(actor, id);
  }
}
