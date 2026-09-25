import { Module } from '@nestjs/common';
import { AgentToolGrantService, McpConnectionService, PersonalConnectionService } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { DB, ENV, SECRET_STORE } from '../../infrastructure/tokens.js';
import { AgentToolsController } from './agent-tools.controller.js';
import { McpConnectionsController } from './mcp-connections.controller.js';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller.js';
import { McpPersonalController } from './mcp-personal.controller.js';

/** MCP connection manager (docs/archive/specs/08): connections wizard, personal connections, agent tool grants, OAuth callback. */
@Module({
  controllers: [McpConnectionsController, McpPersonalController, AgentToolsController, McpOAuthCallbackController],
  providers: [
    {
      provide: McpConnectionService,
      inject: [DB, SECRET_STORE, ENV],
      useFactory: (db: Db, secrets: SecretStore, env: ApiEnv) => new McpConnectionService({ db, secrets, publicUrl: env.OCSO_PUBLIC_URL }),
    },
    { provide: PersonalConnectionService, inject: [DB], useFactory: (db: Db) => new PersonalConnectionService(db) },
    { provide: AgentToolGrantService, inject: [DB], useFactory: (db: Db) => new AgentToolGrantService(db) },
  ],
  exports: [McpConnectionService, PersonalConnectionService, AgentToolGrantService],
})
export class McpModule {}
