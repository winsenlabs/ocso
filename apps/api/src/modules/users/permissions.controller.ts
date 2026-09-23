import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Permission } from '@ocso/auth';
import { PermissionChangeInput, PermissionService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequireAnyPermission, RequirePermission } from '../../common/decorators.js';

/**
 * Per-user permissions (PM/research/11 §3.5): the catalogue, a user's effective
 * permissions with their sources, and changing them. The reductions in a change
 * apply at once (200, `applied`); the widening part is submitted for approval
 * (202, `proposal`) or refused with 409 approval_required when no checker was
 * named — the reductions have applied even then (the 409 says so).
 */
@Controller('v1')
export class PermissionsController {
  constructor(@Inject(PermissionService) private readonly permissions: PermissionService) {}

  @Get('permissions/catalogue')
  @Authenticated()
  catalogue() {
    return this.permissions.catalogue();
  }

  /** permissions.read; another user must share a team with the reader unless they hold users.manage (else 404). */
  @Get('users/:id/permissions')
  @RequirePermission(Permission.PERMISSIONS_READ)
  forUser(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.permissions.forUser(actor, id);
  }

  /** Grants/revokes need permissions.manage and a preset change users.manage(_team): checked in PermissionService. */
  @Post('users/:id/permission-changes')
  @RequireAnyPermission(Permission.PERMISSIONS_MANAGE, Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  async change(
    @Actor() actor: ActorContext,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: PermissionChangeInput }) body: PermissionChangeInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.permissions.change(actor, id, body);
    res.status(result.proposal ? 202 : 200);
    return {
      applied: result.applied,
      direction: result.direction,
      lost: result.appliedClassification.lost,
      teamsRemoved: result.appliedClassification.teamsRemoved,
      sessionsEnded: result.sessionsEnded,
      proposal: result.proposal,
      gained: result.proposedClassification?.gained ?? [],
      teamsAdded: result.proposedClassification?.teamsAdded ?? [],
    };
  }
}
