import { Global, Module } from '@nestjs/common';
import { CustomerClaimsIssuer } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import type { Db } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { DB, ENV, SECRET_STORE } from '../../infrastructure/tokens.js';
import { JwksController, SigningKeysController } from './security.controller.js';

/** Customer identity claims signing (docs/08 §4): public JWKS + Tech Admin key rotation. */
@Global()
@Module({
  controllers: [JwksController, SigningKeysController],
  providers: [
    {
      provide: CustomerClaimsIssuer,
      inject: [DB, SECRET_STORE, ENV],
      useFactory: (db: Db, secrets: SecretStore, env: ApiEnv) => new CustomerClaimsIssuer({ db, secrets, issuer: env.OCSO_PUBLIC_URL }),
    },
  ],
  exports: [CustomerClaimsIssuer],
})
export class SecurityModule {}
