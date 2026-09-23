import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Query } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { CustomerPatch, CustomerService, type ActorContext } from '@ocso/application';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
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

  @Capability({ name: 'customers.search_customers', summary: 'Search customers.', tags: ['find', 'lookup'] })
  @Get()
  @RequirePermission(Permission.CUSTOMERS_READ)
  async search(@CurrentPrincipal() principal: Principal, @Query({ schema: SearchQuery }) q: SearchQuery) {
    return this.customers.search(principal, await this.access.policy(), q);
  }

  @Capability({ name: 'customers.get_customer', summary: "Get one customer's profile and attributes." })
  @Get(':id')
  @RequirePermission(Permission.CUSTOMERS_READ)
  async get(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.customers.get(principal, await this.access.policy(), id);
  }

  @Capability({ name: 'customers.update_customer', summary: "Change a customer's name, language, external reference, attributes or account owner." })
  @Patch(':id')
  @HttpCode(204)
  @RequirePermission(Permission.CUSTOMERS_MANAGE)
  async update(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: CustomerPatch }) body: CustomerPatch) {
    await this.customers.update(actor, id, body, await this.access.policy());
  }
}
