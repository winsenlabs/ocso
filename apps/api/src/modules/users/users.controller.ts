import { Body, Controller, Get, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { Permission } from '@ocso/auth';
import { CreateUserInput, TeamInput, TeamService, UpdateUserInput, UserService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Authenticated, RequirePermission, RequireAnyPermission } from '../../common/decorators.js';

const Availability = z.object({ availability: z.enum(['AVAILABLE', 'AWAY', 'OFFLINE']) });
type Availability = z.infer<typeof Availability>;

@Controller('v1')
export class UsersController {
  constructor(
    @Inject(UserService) private readonly users: UserService,
    @Inject(TeamService) private readonly teams: TeamService,
  ) {}

  @Get('users')
  @RequirePermission(Permission.USERS_READ)
  list(@Actor() actor: ActorContext) {
    return this.users.list(actor);
  }

  /** Permission is resolved in the service: Tech Admin → any role, CS Lead → CS Execs only. */
  @Post('users')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_EXECS)
  create(@Actor() actor: ActorContext, @Body({ schema: CreateUserInput }) body: CreateUserInput) {
    return this.users.create(actor, body);
  }

  @Patch('users/:id')
  @RequireAnyPermission(Permission.USERS_MANAGE, Permission.USERS_MANAGE_EXECS)
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

  @Post('teams')
  @RequirePermission(Permission.TEAMS_MANAGE)
  createTeam(@Actor() actor: ActorContext, @Body({ schema: TeamInput }) body: TeamInput) {
    return this.teams.create(actor, body);
  }

  @Patch('teams/:id')
  @RequirePermission(Permission.TEAMS_MANAGE)
  async updateTeam(@Actor() actor: ActorContext, @Param('id', { schema: z.uuid() }) id: string, @Body({ schema: TeamInput }) body: TeamInput) {
    await this.teams.update(actor, id, body);
    return { ok: true };
  }
}
