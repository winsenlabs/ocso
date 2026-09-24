import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { Permission, type Principal } from '@ocso/auth';
import { confirmLinkToken, listChatLinks, previewLinkToken, revokeChatLink, type ActorContext, type ChatLinkView } from '@ocso/application';
import type { ChannelRegistry } from '@ocso/channels';
import { users, type Db } from '@ocso/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { Actor, Authenticated, CurrentPrincipal, RequirePermission, type OcsoRequest } from '../../common/decorators.js';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';
import { StaffChatService } from './staff-chat.service.js';

const Id = z.uuid();
/** The token travels in the body, never the path, so request logs do not carry it. */
const TokenInput = z.object({ token: z.string().min(1).max(200) });
type TokenInput = z.infer<typeof TokenInput>;

/**
 * Chat account links for Ask OCSO over staff chat channels (Slack, Teams): the `/link/<token>` page's preview and
 * confirm, the signed-in user's own links (Account), and a user's links for a Tech admin with users.manage (Team).
 * Revoking is immediate. Under /v1/internal-agent, so Ask OCSO itself can never link or unlink (delegated requests
 * are refused on these routes, and they are left out of its capability catalog).
 */
@Controller('v1/internal-agent')
export class ChatLinksController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(StaffChatService) private readonly staff: StaffChatService,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
  ) {}

  /** What a one-time chat link would link (channel, chat account) and whether this user may confirm it. */
  @Post('link-tokens/preview')
  @HttpCode(200)
  @Authenticated()
  async preview(@CurrentPrincipal() principal: Principal, @Body({ schema: TokenInput }) body: TokenInput) {
    const preview = await previewLinkToken(this.db, principal, body.token);
    const [you] = await this.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, principal.userId));
    return { ...preview, network: preview.channel ? this.network(preview.channel.kind) : null, you: you ?? null };
  }

  /**
   * Claim the link for the signed-in user: the response carries a code they send from that chat account to finish
   * (proof they hold it). A chat account already linked to this user is refreshed at once (`existing`).
   */
  @Post('link-tokens/confirm')
  @HttpCode(200)
  @Authenticated()
  async confirm(@Actor() actor: ActorContext, @Body({ schema: TokenInput }) body: TokenInput, @Req() req: OcsoRequest) {
    const done = await confirmLinkToken(this.db, actor, req.authSession?.authMethod ?? 'password', body.token);
    // Best effort and not awaited: a slow chat provider never holds the page.
    void this.staff.notifyLinked(done.notify, done.kind);
    if (done.kind === 'code') return { link: null, existing: false, code: done.code, expiresAt: done.expiresAt.toISOString() };
    const [view] = (await listChatLinks(this.db, done.link.userId)).filter((l) => l.id === done.link.id);
    return { link: view ? this.withNetwork(view) : null, existing: true, code: null, expiresAt: null };
  }

  /** The signed-in user's active chat account links. */
  @Get('chat-links')
  @Authenticated()
  async mine(@CurrentPrincipal() principal: Principal) {
    return (await listChatLinks(this.db, principal.userId)).map((l) => this.withNetwork(l));
  }

  /** Revoke a chat account link at once: your own, or anyone's with users.manage. Audited. */
  @Post('chat-links/:id/revoke')
  @HttpCode(200)
  @Authenticated()
  async revoke(@Actor() actor: ActorContext, @Param('id', { schema: Id }) id: string) {
    return this.withNetwork(await revokeChatLink(this.db, actor, id));
  }

  /** A user's active chat account links (Team → user), for a Tech admin with users.manage. */
  @Get('users/:id/chat-links')
  @RequirePermission(Permission.USERS_MANAGE)
  async ofUser(@Param('id', { schema: Id }) id: string) {
    return (await listChatLinks(this.db, id)).map((l) => this.withNetwork(l));
  }

  private network(kind: string): string {
    return this.registry.has(kind) ? this.registry.describe(kind).mark.name : kind;
  }

  private withNetwork(view: ChatLinkView) {
    return { ...view, network: this.network(view.channel.kind) };
  }
}
