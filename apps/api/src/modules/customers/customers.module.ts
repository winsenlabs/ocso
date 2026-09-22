import { Module } from '@nestjs/common';
import { CustomerService } from '@ocso/application';
import type { Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { CustomersController } from './customers.controller.js';

@Module({
  imports: [ConversationsModule],
  controllers: [CustomersController],
  providers: [{ provide: CustomerService, inject: [DB], useFactory: (db: Db) => new CustomerService(db) }],
})
export class CustomersModule {}
