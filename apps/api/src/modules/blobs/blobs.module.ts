import { Module } from '@nestjs/common';
import { BlobsController } from './blobs.controller.js';

@Module({ controllers: [BlobsController] })
export class BlobsModule {}
