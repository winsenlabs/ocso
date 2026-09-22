import { Module } from '@nestjs/common';
import { EmailSettingsService, ScalingStatusService } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { EmailSender, EmailStatus } from '@ocso/email';
import { DB, EMAIL_SENDER, EMAIL_STATUS } from '../../infrastructure/tokens.js';
import { EmailSettingsController } from './email-settings.controller.js';
import { SettingsController } from './settings.controller.js';

@Module({
  controllers: [SettingsController, EmailSettingsController],
  providers: [
    { provide: ScalingStatusService, inject: [DB], useFactory: (db: Db) => new ScalingStatusService(db) },
    {
      provide: EmailSettingsService,
      inject: [DB, EMAIL_SENDER, EMAIL_STATUS],
      useFactory: (db: Db, sender: EmailSender, status: EmailStatus) => new EmailSettingsService(db, sender, status),
    },
  ],
})
export class SettingsModule {}
