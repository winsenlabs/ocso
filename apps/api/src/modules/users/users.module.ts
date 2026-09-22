import { Module } from '@nestjs/common';
import { TeamService, UserService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [UsersController],
  providers: [
    { provide: UserService, inject: [DB], useFactory: (db: Db) => new UserService(db) },
    { provide: TeamService, inject: [DB], useFactory: (db: Db) => new TeamService(db) },
  ],
  exports: [UserService, TeamService],
})
export class UsersModule {}
