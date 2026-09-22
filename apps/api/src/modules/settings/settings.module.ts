import { Module } from '@nestjs/common';
import { ScalingStatusService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { SettingsController } from './settings.controller.js';

@Module({
  controllers: [SettingsController],
  providers: [{ provide: ScalingStatusService, inject: [DB], useFactory: (db: Db) => new ScalingStatusService(db) }],
})
export class SettingsModule {}
