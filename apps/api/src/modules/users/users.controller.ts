import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { AuthMailer, CreateUserInput, TeamInput, TeamService, UpdateUserInput, UserService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequirePermission, RequireAnyPermission } from '../../common/decorators.js';

const Availability = z.object({ availability: z.enum(['AVAILABLE', 'AWAY', 'OFFLINE']) });
const MemberInput = z.object({ userId: z.uuid() });
type MemberInput = z.infer<typeof MemberInput>;
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

  /** Permission is resolved in the service: Tech admin → any role, Lead → Service members only. */
  @Post('users')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateUserInput }) body: CreateUserInput) {
    return this.users.create(actor, body);
  }

  /** How new users get their first sign-in here: emailed invites, or links/passwords handed over (log driver). */
  @Get('users/onboarding')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  onboarding() {
    return { emailDelivery: this.mailer.delivers ? 'email' : 'log', inviteTtlHours: this.users.inviteTtlHours, allowInitialPasswords: this.users.allowInitialPasswords };
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

  @Patch('users/:id')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_TEAM)
  update(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: UpdateUserInput }) body: UpdateUserInput) {
    return this.users.update(actor, id, body);
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

  /** Tech admin: any membership. Lead: Service members and themselves, on teams they belong to (enforced in TeamService). */
  @Post('teams/:id/members')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.TEAMS_MANAGE)
  @HttpCode(204)
  async addMember(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: MemberInput }) body: MemberInput): Promise<void> {
    await this.teams.addMember(actor, id, body.userId);
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
