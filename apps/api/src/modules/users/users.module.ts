import { Logger, Module } from '@nestjs/common';
import { ApprovalService, AuthMailer, PermissionService, TeamService, UserService, createIdentityApprovals, type IdentityApprovals, type IdentityGovernance } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import { DB, ENV } from '../../infrastructure/tokens.js';
import { IDENTITY_APPROVALS, IDENTITY_GOVERNANCE, identityGovernance } from './identity-governance.js';
import { PermissionsController } from './permissions.controller.js';
import { UsersController } from './users.controller.js';

@Module({
  controllers: [UsersController, PermissionsController],
  providers: [
    // Per-user permission increases and new users become `user` / `permission_change` proposals (the approval spine is global).
    { provide: IDENTITY_APPROVALS, inject: [ApprovalService], useFactory: (approvals: ApprovalService) => createIdentityApprovals(approvals) },
    {
      provide: IDENTITY_GOVERNANCE,
      inject: [ENV, IDENTITY_APPROVALS],
      useFactory: (env: ApiEnv, approvals: IdentityApprovals | null) => identityGovernance(env, approvals, (m) => new Logger('Identity').warn(m)),
    },
    {
      provide: UserService,
      inject: [DB, AuthMailer, IDENTITY_GOVERNANCE],
      useFactory: (db: Db, mailer: AuthMailer, governance: IdentityGovernance) => new UserService(db, { mailer, ...governance }),
    },
    { provide: TeamService, inject: [DB, IDENTITY_GOVERNANCE], useFactory: (db: Db, governance: IdentityGovernance) => new TeamService(db, governance) },
    { provide: PermissionService, inject: [DB, IDENTITY_GOVERNANCE], useFactory: (db: Db, governance: IdentityGovernance) => new PermissionService(db, governance) },
  ],
  exports: [UserService, TeamService, PermissionService],
})
export class UsersModule {}
