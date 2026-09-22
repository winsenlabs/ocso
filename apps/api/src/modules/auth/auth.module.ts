import { Module } from '@nestjs/common';
import { SsoProviderService, type AuthServer } from '@ocso/application/auth-server';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import { AUTH, DB, ENV } from '../../infrastructure/tokens.js';
import { trustedOrigins } from '../../infrastructure/auth.providers.js';
import { AuthSettingsController } from './auth-settings.controller.js';
import { AuthController } from './auth.controller.js';
import { TestHooksController } from './test-hooks.controller.js';

/**
 * /v1 side of authentication (ADR-025). Better Auth itself is mounted at
 * /api/auth outside Nest (bootstrap.ts), before the body parsers.
 */
@Module({
  controllers: [AuthController, AuthSettingsController, TestHooksController],
  providers: [
    {
      provide: SsoProviderService,
      inject: [DB, AUTH, ENV],
      useFactory: (db: Db, auth: AuthServer, env: ApiEnv) => new SsoProviderService(db, auth, { publicUrl: env.OCSO_PUBLIC_URL, trustedOrigins: trustedOrigins(env) }),
    },
  ],
})
export class AuthModule {}
