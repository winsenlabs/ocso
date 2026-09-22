import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { ProfileInput, ProfilePatch, ProfileService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequirePermission } from '../../common/decorators.js';

/** Logical model profiles (docs/06 §2). */
@Controller('v1/model-profiles')
export class ModelProfilesController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  /** providers.read OR agents.read (CS Leads pick profiles for agents); checked in the service. */
  @Get()
  @Authenticated()
  list(@Actor() actor: ActorContext) {
    return this.profiles.list(actor);
  }

  /** Dry-run policy check for the profile dialog (residency, allowlist, fallback rules). */
  @Post('validate')
  @HttpCode(200)
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  validate(@Actor() actor: ActorContext, @Body({ schema: ProfileInput }) body: ProfileInput) {
    return this.profiles.validate(actor, body);
  }

  @Get(':id')
  @Authenticated()
  get(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.profiles.get(actor, id);
  }

  @Post()
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  create(@Actor() actor: ActorContext, @Body({ schema: ProfileInput }) body: ProfileInput) {
    return this.profiles.create(actor, body);
  }

  @Patch(':id')
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: ProfilePatch }) body: ProfilePatch) {
    return this.profiles.update(actor, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(Permission.MODEL_PROFILES_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.profiles.delete(actor, id);
  }
}
