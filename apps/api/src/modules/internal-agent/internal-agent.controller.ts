import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { Permission, type Principal } from '@ocso/auth';
import { InternalActionService, InternalAgentService } from '@ocso/internal-agent';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission, type OcsoRequest } from '../../common/decorators.js';

const Id = z.uuid();
/** useChat sends UI messages; we only need the latest user text (history lives server-side). */
const ChatInput = z.object({
  threadId: z.uuid().nullable().optional(),
  message: z.object({
    role: z.literal('user'),
    parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()).min(1),
  }),
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
          },
          correlationId,
          abort.signal,
        );
        if (textOpen) writer.write({ type: 'text-end', id: textId });
        writer.write({ type: 'data-thread', data: { threadId } });
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
