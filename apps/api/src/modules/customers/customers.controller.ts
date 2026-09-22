import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { CustomerPatch, CustomerService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { ConversationAccessService } from '../conversations/conversation-access.service.js';

const Id = z.uuid();
const SearchQuery = z.object({ search: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
type SearchQuery = z.infer<typeof SearchQuery>;

@Controller('v1/customers')
export class CustomersController {
  constructor(
    @Inject(CustomerService) private readonly customers: CustomerService,
    @Inject(ConversationAccessService) private readonly access: ConversationAccessService,
  ) {}

  @Get()
  @RequirePermission(Permission.CUSTOMERS_READ)
  async search(@CurrentPrincipal() principal: Principal, @Query({ schema: SearchQuery }) q: SearchQuery) {
    return this.customers.search(principal, await this.access.policy(), q);
  }

  @Get(':id')
  @RequirePermission(Permission.CUSTOMERS_READ)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.customers.get(principal, await this.access.policy(), id);
  }

  @Patch(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CUSTOMERS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: CustomerPatch }) body: CustomerPatch) {
    await this.customers.update(actor, id, body, await this.access.policy());
  }
}
