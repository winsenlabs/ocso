import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import { Permission, type Principal } from '@ocso/auth';
import { validation } from '@ocso/domain';
import { and, eq } from 'drizzle-orm';
import { InternalActionService, InternalAgentService, capabilityByName, capabilitySuggestions, currentCard, isWriteCapability, type CapabilitySuggestions } from '@ocso/internal-agent';
import { SessionLiveness } from '@ocso/application';
import type { ApiEnv } from '@ocso/config';
import { internalAgentActions, type Db } from '@ocso/db';
import { notFound } from '@ocso/domain';
import { z } from 'zod';
import { CurrentPrincipal, RequirePermission, type OcsoRequest } from '../../common/decorators.js';
import { abortWhenSessionEnds } from '../../common/session-watch.js';
import { DB, ENV } from '../../infrastructure/tokens.js';

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
 * Governed cards name the checker and why (PM/research/12 §5); other cards send nothing. `credentials`: what the user
 * typed into the card's own credential fields (§9), by field key. Never stored; used for this one call only.
 */
const ConfirmInput = z.object({
  checkerId: z.uuid().optional(),
  reason: z.string().trim().min(3).max(500).optional(),
  credentials: z
    .record(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/, 'a credential field key'), z.string().max(16_000, 'at most 16000 characters'))
    .refine((c) => Object.keys(c).length <= 20, 'at most 20 credential fields')
    .optional(),
});
type ConfirmInput = z.infer<typeof ConfirmInput>;

/**
 * Ask OCSO (design/05, PM/research/12): streams AI SDK UI message chunks. Tool links, tables, confirmation cards
 * (`data-action`, the ActionCard) and RBAC refusals arrive as typed `data-*` parts. Left out of the capability
 * catalog (scripts/capabilities): Ask OCSO never drives itself.
 */
@Controller('v1/internal-agent')
export class InternalAgentController {
  constructor(
    @Inject(InternalAgentService) private readonly agent: InternalAgentService,
    @Inject(InternalActionService) private readonly actions: InternalActionService,
    @Inject(SessionLiveness) private readonly liveness: SessionLiveness,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: Db,
  ) {}

  @Post('chat')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  async chat(@CurrentPrincipal() principal: Principal, @Body({ schema: ChatInput }) body: ChatInput, @Req() req: OcsoRequest, @Res() res: Response): Promise<void> {
    const text = body.message.parts.flatMap((p) => (p.type === 'text' && p.text ? [p.text] : [])).join('\n').trim();
    const correlationId = req.correlationId ?? randomUUID();
    // Before streaming, so the drawer gets a typed 400 it can turn into its setup state.
    if (!(await this.agent.configured())) throw validation('internal_agent_not_configured', 'A Tech admin must choose a model profile for Ask OCSO');
    const abort = new AbortController();
    // Long answers re-check the session like every stream (ADR-025): revocation stops the model call.
    const stopWatching = abortWhenSessionEnds(this.liveness, req.authSession?.id, this.env.SESSION_STREAM_RECHECK_SECONDS * 1000, abort, principal);
    res.on('close', () => {
      stopWatching();
      abort.abort();
    });
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
            card: (card) => writer.write({ type: 'data-action', id: card.id, data: card }),
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

  /** "What can you do?": suggestion chips and a per-area summary from the catalog, for this user's permissions. */
  @Get('capabilities/suggestions')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  async suggestions(@CurrentPrincipal() principal: Principal) {
    return readsOnlyUnless(await this.actions.writesEnabled(), capabilitySuggestions(principal));
  }

  /**
   * Where one of the caller's cards stands now (the drawer re-reads it when a confirm outlives its own wait).
   * `running` is true while a confirm is still in progress: the card then reads PENDING but must not be offered again.
   */
  @Get('actions/:id')
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  async action(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string) {
    const [row] = await this.db.select().from(internalAgentActions).where(and(eq(internalAgentActions.id, id), eq(internalAgentActions.userId, principal.userId)));
    const card = row ? currentCard(row) : null;
    if (!row || !card) throw notFound('internal_agent_action', id);
    return { ...card, running: row.status === 'CONFIRMING' && card.status === 'PENDING' };
  }

  /**
   * Run a confirmation card: a fresh permission check, the card's hash against the object now (STALE when it
   * changed), then the real route as this user — applied (direct, stop) or submitted to the chosen checker
   * (governed: `checkerId` and `reason` required). Answers the card with its final status and result. A card with
   * credential fields takes their values in `credentials` (required ones checked here); a secret the route
   * generates comes back once in `reveal` on this response only, never on the stored card or in the thread.
   */
  @Post('actions/:id/confirm')
  @HttpCode(200)
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  confirm(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Body({ schema: ConfirmInput }) body: ConfirmInput, @Req() req: OcsoRequest) {
    return this.actions.confirm(principal, id, body ?? {}, req.correlationId ?? randomUUID());
  }

  /** Cancel a card: nothing changes; audited. Answers the card marked REJECTED. */
  @Post('actions/:id/reject')
  @HttpCode(200)
  @RequirePermission(Permission.INTERNAL_AGENT_USE)
  reject(@CurrentPrincipal() principal: Principal, @Param('id', { schema: Id }) id: string, @Req() req: OcsoRequest) {
    return this.actions.reject(principal, id, req.correlationId ?? randomUUID());
  }
}

/**
 * With the writes kill switch off, "What can you do?" offers reads only: no change chips, no change counts,
 * and `writesOn: false` so the drawer says changes are turned off by the deployment settings.
 */
export function readsOnlyUnless(writesOn: boolean, s: CapabilitySuggestions): CapabilitySuggestions & { writesOn: boolean } {
  if (writesOn) return { ...s, writesOn };
  const isWrite = (tool: string) => {
    const c = capabilityByName(tool);
    return c === undefined || isWriteCapability(c);
  };
  const areas = s.areas.filter((a) => a.reads > 0).map((a) => ({ ...a, writes: 0 }));
  return { suggestions: s.suggestions.filter((x) => !isWrite(x.tool)), areas, total: areas.reduce((n, a) => n + a.reads, 0), writesOn };
}
