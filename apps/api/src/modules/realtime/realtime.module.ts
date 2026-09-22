import { Global, Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeHub } from './realtime.hub.js';

@Global()
@Module({ controllers: [RealtimeController], providers: [RealtimeHub], exports: [RealtimeHub] })
export class RealtimeModule {}
