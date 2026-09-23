import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { Permission, type Principal } from '@ocso/auth';
import { HumanToolService } from '@ocso/agent-runtime';
import type { ActorContext } from '@ocso/application';
import { notFound } from '@ocso/domain';
import { toolCalls, type Db } from '@ocso/db';
import { z } from 'zod';
import { Actor, Capability, CurrentPrincipal, RequirePermission } from '../../common/decorators.js';
import { DB } from '../../infrastructure/tokens.js';
import { ConversationAccessService } from './conversation-access.service.js';

const Id = z.uuid();
const RunInput = z.object({ toolId: z.uuid(), args: z.record(z.string(), z.unknown()).default({}), confirmed: z.boolean().default(false) });
type RunInput = z.infer<typeof RunInput>;
const DenyInput = z.object({ reason: z.string().trim().min(3).max(500) });
type DenyInput = z.infer<typeof DenyInput>;

/** Human tool actions and sensitive-action confirmation (design/01 composer "Tool action" + confirm card). */
@Controller('v1')
export class ConversationToolsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(HumanToolService) private readonly tools: HumanToolService,
    @Inject(ConversationAccessService) private readonly access: ConversationAccessService,
  ) {}

  @Capability({ name: 'conversations.list_conversation_tools', summary: 'List the tools a person can run in a conversation.', tags: ['tool'] })
  @Get('conversations/:id/tools')
  @RequirePermission(Permission.CONVERSATIONS_READ)
  async list(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    await this.access.assert(principal, id);
    const [available, pending] = await Promise.all([
      this.tools.available(principal),
      this.db
        .select({ id: toolCalls.id, toolName: toolCalls.toolName, args: toolCalls.argsSanitized, reason: toolCalls.confirmationReason, expiresAt: toolCalls.confirmationExpiresAt, requestedAt: toolCalls.requestedAt })
        .from(toolCalls)
        .where(and(eq(toolCalls.conversationId, id), eq(toolCalls.status, 'AWAITING_CONFIRMATION'))),
    ]);
    return { available, pendingConfirmations: pending };
  }

  @Capability({ name: 'conversations.run_conversation_tool', summary: 'Run a tool in a conversation as the human agent (e.g. look up an order).', tags: ['tool', 'lookup'] })
  @Post('conversations/:id/tools/run')
  @RequirePermission(Permission.TOOLS_EXECUTE_HUMAN)
  async run(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: RunInput }) body: RunInput) {
    await this.access.assert(actor.principal!, id);
    return this.tools.run(actor, id, body.toolId, body.args, body.confirmed);
  }

  @Capability({ name: 'conversations.confirm_tool_call', summary: 'Confirm a sensitive tool call the AI agent is waiting on.', tags: ['tool', 'confirm'] })
  @Post('tool-calls/:id/confirm')
  @RequirePermission(Permission.TOOLS_CONFIRM_SENSITIVE)
  async confirm(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    await this.assertCallAccess(actor.principal!, id);
    return this.tools.confirm(actor, id);
  }

  @Capability({ name: 'conversations.deny_tool_call', summary: 'Deny a sensitive tool call the AI agent is waiting on, with a reason.', tags: ['tool', 'deny'] })
  @Post('tool-calls/:id/deny')
  @HttpCode(204)
  @RequirePermission(Permission.TOOLS_CONFIRM_SENSITIVE)
  async deny(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string, @Body({ schema: DenyInput }) body: DenyInput) {
    await this.assertCallAccess(actor.principal!, id);
    await this.tools.deny(actor, id, body.reason);
  }

  private async assertCallAccess(principal: Principal, toolCallId: string): Promise<void> {
    const [call] = await this.db.select({ conversationId: toolCalls.conversationId }).from(toolCalls).where(eq(toolCalls.id, toolCallId));
    if (!call?.conversationId) throw notFound('tool_call', toolCallId);
    await this.access.assert(principal, call.conversationId);
  }
}
