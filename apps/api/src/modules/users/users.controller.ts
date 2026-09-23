import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Permission } from '@ocso/auth';
import { AddMemberInput, AuthMailer, CreateUserInput, TeamInput, TeamService, UpdateUserInput, UserService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequirePermission, RequireAnyPermission } from '../../common/decorators.js';

const Availability = z.object({ availability: z.enum(['AVAILABLE', 'AWAY', 'OFFLINE']) });
type Availability = z.infer<typeof Availability>;

@Controller('v1')
export class UsersController {
  constructor(
    @Inject(UserService) private readonly users: UserService,
    @Inject(TeamService) private readonly teams: TeamService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
  ) {}

  @Get('users')
  @RequirePermission(Permission.USERS_READ)
  list(@Actor() actor: ActorContext) {
    return this.users.list(actor);
  }

  /**
   * Maker rules in the service (users.manage: any preset; users.manage_team: shared teams, containment).
   * The user is created PENDING_APPROVAL (201, with `approvalRequired`), or submitted for approval with
   * `approval` (202, with `proposal`). Development deployments may create them ACTIVE (201).
   */
  @Post('users')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  async create(@Actor() actor: ActorContext, @Body({ schema: CreateUserInput }) body: CreateUserInput, @Res({ passthrough: true }) res: Response) {
    const created = await this.users.create(actor, body);
    res.status(created.proposal ? 202 : 201);
    return created;
  }

  /** How new users get their first sign-in here: emailed invites, or links/passwords handed over (log driver). */
  @Get('users/onboarding')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  onboarding() {
    return {
      emailDelivery: this.mailer.delivers ? 'email' : 'log',
      inviteTtlHours: this.users.inviteTtlHours,
      allowInitialPasswords: this.users.allowInitialPasswords,
      approvalRequired: this.users.approvalRequired,
    };
  }

  @Post('users/:id/invite')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  @HttpCode(200)
  resendInvite(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.users.resendInvite(actor, id);
  }

  @Post('users/:id/password-reset')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  @HttpCode(200)
  sendPasswordReset(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.users.sendPasswordReset(actor, id);
  }

  /**
   * Reductions apply at once (200); the widening part is proposed (202) or refused with 409 approval_required
   * (the reductions still apply). On a pending user, `status: 'ACTIVE'` or `approval` submits their creation.
   */
  @Patch('users/:id')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  async update(
    @Actor() actor: ActorContext,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: UpdateUserInput }) body: UpdateUserInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const updated = await this.users.update(actor, id, body);
    res.status(updated.proposal ? 202 : 200);
    return updated;
  }

  /** Discard a user whose creation was never approved (PENDING_APPROVAL only; frees the email). Same maker rules. */
  @Delete('users/:id')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  @HttpCode(204)
  async discard(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.users.discard(actor, id);
  }

  @Put('me/availability')
  @Authenticated()
  async setAvailability(@Actor() actor: ActorContext, @Body({ schema: Availability }) body: Availability) {
    await this.users.setAvailability(actor, body.availability);
    return { availability: body.availability };
  }

  @Get('teams')
  @Authenticated()
  listTeams() {
    return this.teams.list();
  }

  /** One team with its members, roles and join dates (the team drawer on the Team page). */
  @Get('teams/:id')
  @RequirePermission(Permission.USERS_READ)
  getTeam(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string) {
    return this.teams.get(actor, id);
  }

  @Post('teams')
  @RequirePermission(Permission.TEAMS_MANAGE)
  createTeam(@Actor() actor: ActorContext, @Body({ schema: TeamInput }) body: TeamInput) {
    return this.teams.create(actor, body);
  }

  /**
   * users.manage: any membership; teams.manage: on teams they belong to (TeamService). Joining a team widens
   * an active user's scope: 202 with the proposal, or 409 approval_required; 204 when it applied.
   */
  @Post('teams/:id/members')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.TEAMS_MANAGE)
  async addMember(
    @Actor() actor: ActorContext,
    @Param('id', { schema: z.uuid() }) id: string,
    @Body({ schema: AddMemberInput }) body: AddMemberInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { proposal } = await this.teams.addMember(actor, id, body);
    if (!proposal) {
      res.status(204);
      return undefined;
    }
    res.status(202);
    return { proposal };
  }

  @Delete('teams/:id/members/:userId')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.TEAMS_MANAGE)
  @HttpCode(204)
  async removeMember(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Param('userId', { schema: z.uuid() }) userId: string): Promise<void> {
    await this.teams.removeMember(actor, id, userId);
  }

  /** Rename / describe: Leads, on teams they belong to (enforced in TeamService). */
  @Patch('teams/:id')
  @RequirePermission(Permission.TEAMS_MANAGE)
  async updateTeam(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: TeamInput }) body: TeamInput) {
    await this.teams.update(actor, id, body);
    return { ok: true };
  }
}
