import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { Permission, type Principal } from '@ocso/auth';
import { validation } from '@ocso/domain';
import { InternalActionService, InternalAgentService } from '@ocso/internal-agent';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission, type OcsoRequest } from '../../common/decorators.js';

const Id = z.uuid();
/** The page the user has open (design/05 "context · …"): an in-app path plus the object ids on it. */
const PageContextInput = z.object({
  path: z.string().max(300).regex(/^\/[A-Za-z0-9/_\-.~%?=&]*$/, 'an OCSO path'),
  conversationId: z.uuid().optional(),
  agentId: z.uuid().optional(),
});
/** useChat sends UI messages; we only need the latest user text (history lives server-side). */
const ChatInput = z.object({
  threadId: z.uuid().nullable().optional(),
  message: z.object({
    role: z.literal('user'),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).min(1),
  }),
  context: PageContextInput.nullable().optional(),
});
type ChatInput = z.infer<typeof ChatInput>;

/**
 * Ask OCSO (design/05, docs/12): streams AI SDK UI message chunks. Tool links,
 * tables, confirmation cards and RBAC refusals arrive as typed `data-*` parts.
 */
@Controller('v1/internal-agent')
export class InternalAgentController {
  constructor(
    @Inject(InternalAgentService) private readonly agent: InternalAgentService,
    @Inject(InternalActionService) private readonly actions: InternalActionService,
  ) {}

  @Post('chat')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  async chat(@CurrentPrincipal() principal: Principal, @Body({ schema: ChatInput }) body: ChatInput, @Req() req: OcsoRequest, @Res() res: Response): Promise<void> {
    const text = body.message.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('\n').trim();
    const correlationId = req.correlationId ?? randomUUID();
    // Before streaming, so the drawer gets a typed 400 it can turn into its setup state.
    if (!(await this.agent.configured())) throw validation('internal_agent_not_configured', 'A Tech Admin must choose a model profile for Ask OCSO');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const textId = randomUUID();
        let textOpen = false;
        writer.write({ type: 'start' });
        const { threadId } = await this.agent.ask(
          principal,
          body.threadId ?? null,
          text,
          {
            text: (delta) => {
              if (!textOpen) {
                writer.write({ type: 'text-start', id: textId });
                textOpen = true;
              }
              writer.write({ type: 'text-delta', id: textId, delta });
            },
            step: (label) => writer.write({ type: 'data-step', data: { label }, transient: true }),
            links: (links) => writer.write({ type: 'data-links', data: links }),
            table: (table) => writer.write({ type: 'data-table', data: table }),
            action: (action) => writer.write({ type: 'data-action', data: action }),
            denied: (message) => writer.write({ type: 'data-denied', data: { message } }),
            thread: (id) => writer.write({ type: 'data-thread', id: 'thread', data: { threadId: id } }),
          },
          correlationId,
          abort.signal,
          body.context ?? null,
        );
        if (textOpen) writer.write({ type: 'text-end', id: textId });
        writer.write({ type: 'data-thread', id: 'thread', data: { threadId } });
        writer.write({ type: 'finish' });
      },
      onError: (err) => {
        const e = err as { code?: string; message?: string; category?: string };
        return e.category === 'validation' || e.category === 'authorization' ? (e.message ?? 'Request not allowed') : 'Ask OCSO could not answer right now.';
      },
    });
    pipeUIMessageStreamToResponse({ response: res, stream, headers: { 'x-correlation-id': correlationId } });
  }

  @Get('threads')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  threads(@CurrentPrincipal() principal: Principal) {
    return this.agent.threads(principal);
  }

  @Get('threads/:id/messages')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  messages(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    return this.agent.messages(principal, id);
  }

  @Post('actions/:id/confirm')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  confirm(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Req() req: OcsoRequest) {
    return this.actions.confirm(principal, id, req.correlationId ?? randomUUID());
  }

  @Post('actions/:id/reject')
  @HttpCode(204)
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  async reject(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Req() req: OcsoRequest) {
    await this.actions.reject(principal, id, req.correlationId ?? randomUUID());
  }
}
