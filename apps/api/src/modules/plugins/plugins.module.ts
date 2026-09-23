import { Module } from '@nestjs/common';
import { PluginsController } from './plugins.controller.js';

@Module({ controllers: [PluginsController] })
export class PluginsModule {}
