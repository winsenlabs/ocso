import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, count, eq, gt, lt } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { AuthPolicyService, LINK_CODE_DIGITS, chatLinkRefusal, completeChatLink, findActiveChatLink, hashLinkToken, issueLinkToken, loadPrincipal, mfaPending, touchChatLink, type ChatLink } from '@ocso/application';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelRegistry, InboundMessage } from '@ocso/channels';
import type { ApiEnv } from '@ocso/config';
import { channelLinkTokens, channelStaffMessages, channels, internalAgentActions, internalAgentThreads, users, uuidv7, type Db } from '@ocso/db';
import { InternalActionService, InternalAgentService, currentCard, stableJson, type ActionCard } from '@ocso/internal-agent';
import { CHANNEL_REGISTRY, DB, ENV } from '../../infrastructure/tokens.js';
import { ChatReply, ChatText, cardClick, confirmableInChat, failureText, textOf, type Answer } from './staff-chat-format.js';

export { cardOptionId } from './staff-chat-format.js';

/** At most this many messages a minute per linked chat account (the rest are dropped, with one notice). */
export const STAFF_MESSAGES_PER_MINUTE = 20;
/** One chat answer may take this long (the model and its reads); the chat hears "could not answer" after it. */
export const STAFF_ASK_TIMEOUT_MS = 180_000;
/** Dedupe rows older than this are pruned (providers retry within minutes). */
const DEDUPE_KEEP_MS = 2 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 10 * 60_000;

/**
 * Ask OCSO through a staff chat channel (a channel whose kind sets `staffDestination` and whose `destination`
 * setting is `ask_ocso`): nothing here creates customer conversations.
 *
 * Each inbound message is taken once (provider retries dedupe on the message id), then answered in the background so
 * the webhook acknowledges at once (Slack wants an answer within 3 seconds). An unknown sender gets a one-time link
 * to link their chat account; a linked sender's message runs Ask OCSO as their OCSO user, loaded fresh (rights,
 * status, internal_agent.use, the MFA policy as linked), in a thread per (link, chat thread) that the drawer also
 * lists. Delegated reads and card confirms run through the loopback runner with a token bound to the link instead of
 * a session. Answers are final text (no streaming) with object links as absolute OCSO URLs; direct and stop cards
 * become Confirm / Cancel buttons that only the same linked chat identity can press; governed cards and cards
 * with credentials link into OCSO instead.
 */
@Injectable()
export class StaffChatService implements OnModuleDestroy {
  private readonly logger = new Logger('StaffChat');
  private readonly running = new Set<Promise<void>>();
  private readonly origin: string;
  private readonly text: ChatText;
  private prunedAt = 0;
  /** When each link last heard the rate-limit notice. */
  private readonly limitNoticeAt = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(InternalAgentService) private readonly agent: InternalAgentService,
    @Inject(InternalActionService) private readonly actions: InternalActionService,
    @Inject(AuthPolicyService) private readonly authPolicy: AuthPolicyService,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.origin = new URL(env.OCSO_PUBLIC_URL).origin;
    this.text = new ChatText(this.origin);
  }

  /** True when this channel's messages go to Ask OCSO rather than to customer conversations. */
  handles(kind: string, settings: Readonly<Record<string, unknown>>): boolean {
    return this.registry.destination(kind, settings) === 'ask_ocso';
  }

  /** Take a webhook's messages (once each) and answer them in the background. */
  async receive(channelId: string, messages: readonly InboundMessage[], correlationId: string): Promise<{ accepted: number; duplicates: number }> {
    let accepted = 0;
    let duplicates = 0;
    for (const message of messages) {
      const [taken] = await this.db.insert(channelStaffMessages).values({ channelId, externalMessageId: message.externalMessageId }).onConflictDoNothing().returning({ id: channelStaffMessages.externalMessageId });
      if (!taken) {
        duplicates++;
        continue;
      }
      accepted++;
      this.track(this.handle(channelId, message, `${correlationId}:${message.externalMessageId}`.slice(0, 200)));
    }
    if (accepted) await this.db.update(channels).set({ lastInboundAt: new Date() }).where(eq(channels.id, channelId));
    await this.prune();
    return { accepted, duplicates };
  }

  /** Resolves once every background answer has finished (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
  }

  /**
   * Tell a chat identity, where it asked for the link, what the link page did: `linked` ("Linked. Ask me anything.",
   * when it was already this user's) or `code` (send the code the page shows; the code itself is never posted).
   * Best effort.
   */
  async notifyLinked(input: { channelId: string; identityKind: string; identityValue: string; replyContext: Record<string, string> | null }, outcome: 'linked' | 'code' = 'linked'): Promise<void> {
    try {
      const { adapter, config } = await this.runtime.load(input.channelId);
      const message: InboundMessage = { externalMessageId: 'link', identityKind: input.identityKind, identityValue: input.identityValue, alternateIdentities: [], receivedAt: new Date(), parts: [], ...(input.replyContext ? { replyContext: input.replyContext } : {}) };
      await new ChatReply(adapter, config, message, this.logger).text(outcome === 'linked' ? 'Linked. Ask me anything.' : `Almost linked: send me the ${LINK_CODE_DIGITS}-digit code the OCSO page shows you, here, to finish.`);
    } catch (err) {
      this.logger.warn(`could not tell channel ${input.channelId} the account is linked: ${(err as Error).message}`);
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => this.logger.error(`staff chat message failed: ${(err as Error).message}`)).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  private async prune(): Promise<void> {
    const now = Date.now();
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    await this.db.delete(channelStaffMessages).where(lt(channelStaffMessages.receivedAt, new Date(now - DEDUPE_KEEP_MS)));
  }

  private async handle(channelId: string, message: InboundMessage, correlationId: string): Promise<void> {
    const { adapter, config, row } = await this.runtime.load(channelId);
    if (row.status !== 'ACTIVE' || !this.handles(row.kind, row.settings)) return;
    const chat = new ChatReply(adapter, config, message, this.logger);
    const surface = this.registry.staffSurface(row.kind);

    const link = await findActiveChatLink(this.db, channelId, message.identityKind, message.identityValue);
    if (!link) return this.unlinked(chat, row.kind, channelId, message, correlationId);
    await this.db
      .update(channelStaffMessages)
      .set({ linkId: link.id })
      .where(and(eq(channelStaffMessages.channelId, channelId), eq(channelStaffMessages.externalMessageId, message.externalMessageId)));

    const access = await this.principalFor(link, surface);
    if (access.kind === 'removed') {
      await chat.text(`Your OCSO access to Ask OCSO was removed (${access.reason}) Ask a Tech admin if you still need it.`);
      return;
    }
    if (access.kind === 'mfa') return this.offerLink(chat, row.kind, channelId, message, 'Your organization now requires two-factor authentication: sign in to OCSO with it and link again');
    const principal = access.principal;

    const [recent] = await this.db
      .select({ n: count() })
      .from(channelStaffMessages)
      .where(and(eq(channelStaffMessages.linkId, link.id), gt(channelStaffMessages.receivedAt, new Date(Date.now() - 60_000))));
    const n = recent?.n ?? 0;
    if (n > STAFF_MESSAGES_PER_MINUTE) {
      // One notice a minute per link (in this process); the other messages over the limit are dropped quietly.
      const noticed = this.limitNoticeAt.get(link.id) ?? 0;
      if (Date.now() - noticed < 60_000) return;
      this.limitNoticeAt.set(link.id, Date.now());
      for (const [id, at] of this.limitNoticeAt) if (Date.now() - at > 60_000) this.limitNoticeAt.delete(id);
      await chat.text(`You are sending messages faster than Ask OCSO answers (at most ${STAFF_MESSAGES_PER_MINUTE} a minute). Wait a moment, then ask again.`);
      return;
    }
    await touchChatLink(this.db, link.id);

    const click = cardClick(message.parts);
    if (click) return this.click(chat, link, principal, click, correlationId);

    const text = textOf(message.parts);
    if (!text) {
      await chat.text('I read text only: ask me in words.');
      return;
    }
    if (!(await this.agent.configured())) {
      await chat.text('Ask OCSO is not set up yet: a Tech admin chooses its model in OCSO Settings.');
      return;
    }
    const threadId = await this.thread(link, message, text, surface);
    const answer: Answer = { text: '', links: [], tables: [], cards: [], denied: [] };
    try {
      await this.agent.ask(
        principal,
        threadId,
        text,
        {
          text: (delta) => void (answer.text += delta),
          step: () => undefined,
          links: (links) => void answer.links.push(...links),
          table: (table) => void answer.tables.push(table),
          card: (card) => void answer.cards.push(card),
          denied: (message) => void answer.denied.push(message),
        },
        correlationId,
        AbortSignal.timeout(STAFF_ASK_TIMEOUT_MS),
      );
    } catch (err) {
      await chat.text(failureText(err));
      return;
    }
    await chat.send(this.text.answerParts(answer, threadId));
  }

  /** The linked user, fresh: ACTIVE, holding internal_agent.use, and admitted by the MFA policy as they linked. */
  private async principalFor(link: ChatLink, surface: string): Promise<{ kind: 'ok'; principal: Principal } | { kind: 'removed'; reason: string } | { kind: 'mfa' }> {
    const loaded = await loadPrincipal(this.db, link.userId, 'INTERNAL_AGENT');
    const refusal = chatLinkRefusal(loaded);
    if (!loaded || refusal) return { kind: 'removed', reason: refusal ?? 'Your OCSO account is not active.' };
    const [user] = await this.db.select({ twoFactorEnabled: users.twoFactorEnabled }).from(users).where(eq(users.id, link.userId));
    const mfa = await this.authPolicy.mfaState(loaded.role, link.authMethod, user?.twoFactorEnabled ?? false, loaded.permissions);
    if (mfaPending(mfa)) return { kind: 'mfa' };
    return { kind: 'ok', principal: { ...loaded, chatLink: { linkId: link.id, surface } } };
  }

  /**
   * A sender with no active link. When a link page claimed one of their link tokens, this message must be that
   * page's code: the right code (from this very chat identity) makes the link. Otherwise they get a one-time link.
   */
  private async unlinked(chat: ChatReply, kind: string, channelId: string, message: InboundMessage, correlationId: string): Promise<void> {
    const done = await completeChatLink(this.db, { channelId, identityKind: message.identityKind, identityValue: message.identityValue, text: textOf(message.parts), correlationId });
    switch (done.kind) {
      case 'none':
        return this.offerLink(chat, kind, channelId, message, 'Link your account');
      case 'waiting':
        await chat.text(`To finish linking, send me the ${LINK_CODE_DIGITS}-digit code the OCSO link page shows you (only the digits).`);
        return;
      case 'wrong':
        await chat.text(done.attemptsLeft > 0 ? `That is not the code the OCSO page shows. ${done.attemptsLeft} tries left.` : 'That is not the code, and there are no tries left. Send me a new message to get a fresh link.');
        return;
      case 'refused':
        await chat.text(`Not linked: ${done.reason}`);
        return;
      case 'linked':
        await chat.text('Linked. Ask me anything.');
        return;
    }
  }

  /** An unknown (or no longer admitted) sender: a one-time link, sent to them privately where the channel can. */
  private async offerLink(chat: ChatReply, kind: string, channelId: string, message: InboundMessage, lead: string): Promise<void> {
    const token = await issueLinkToken(this.db, {
      channelId,
      identityKind: message.identityKind,
      identityValue: message.identityValue,
      profileName: message.profileName,
      replyContext: message.replyContext,
    });
    // Links already went out for this account in the last 10 minutes: stay quiet rather than flood the chat.
    if (!token) return;
    const network = this.registry.has(kind) ? this.registry.describe(kind).mark.name : 'chat';
    const sent = await chat.private(
      `${lead}: ${this.origin}/link/${token}\n\nTo ask OCSO here, link this ${network} account to your OCSO account once. The link works once, for 10 minutes, and asks you to sign in to OCSO.`,
      `To ask OCSO, link your ${network} account to your OCSO account first: message me directly (a 1:1 chat with me) and I will send you a one-time link there.`,
    );
    // Not delivered: nobody holds the link, so drop it; the sender gets a fresh one as soon as they message directly.
    if (!sent) await this.db.delete(channelLinkTokens).where(eq(channelLinkTokens.tokenHash, hashLinkToken(token)));
  }

  /** The Ask OCSO thread of this chat thread (per link), created on first use and listed in the drawer too. */
  private async thread(link: ChatLink, message: InboundMessage, text: string, surface: string): Promise<string> {
    const where = message.replyContext ? stableJson(message.replyContext) : `identity:${message.identityValue}`;
    const key = createHash('sha256').update(where).digest('hex').slice(0, 40);
    const find = async () => {
      const [row] = await this.db
        .select({ id: internalAgentThreads.id })
        .from(internalAgentThreads)
        .where(and(eq(internalAgentThreads.channelLinkId, link.id), eq(internalAgentThreads.chatThreadKey, key)));
      return row?.id ?? null;
    };
    const found = await find();
    if (found) return found;
    await this.db
      .insert(internalAgentThreads)
      .values({ id: uuidv7(), userId: link.userId, title: text.slice(0, 80), surface, channelLinkId: link.id, chatThreadKey: key })
      .onConflictDoNothing();
    return (await find())!;
  }

  /** A card button: only the same linked chat identity whose user owns the card; then the drawer's confirm path. */
  private async click(chat: ChatReply, link: ChatLink, principal: Principal, click: { cardId: string; decision: 'confirm' | 'cancel' }, correlationId: string): Promise<void> {
    const [row] = await this.db
      .select({ action: internalAgentActions, linkId: internalAgentThreads.channelLinkId })
      .from(internalAgentActions)
      .innerJoin(internalAgentThreads, eq(internalAgentThreads.id, internalAgentActions.threadId))
      .where(eq(internalAgentActions.id, click.cardId));
    if (!row || row.action.userId !== link.userId || row.linkId !== link.id) {
      await chat.text('This button is not yours: only the person who asked can confirm or cancel it.');
      return;
    }
    const card = currentCard(row.action);
    if (!card) {
      await chat.text('This card is from an earlier version of Ask OCSO: ask again.');
      return;
    }
    if (card.status !== 'PENDING') {
      await chat.send([{ type: 'TEXT', text: this.text.outcomeText(card) }]);
      return;
    }
    if (!confirmableInChat(card)) {
      await chat.send(this.text.cardParts(card, row.action.threadId));
      return;
    }
    let done: ActionCard;
    try {
      done = click.decision === 'confirm' ? await this.actions.confirm(principal, card.id, {}, correlationId) : await this.actions.reject(principal, card.id, correlationId);
    } catch (err) {
      await chat.text(failureText(err));
      return;
    }
    // A direct change the route turned into an approval comes back as a governed card: that one is finished in OCSO.
    await chat.send(done.status === 'PENDING' ? this.text.cardParts(done, row.action.threadId) : [{ type: 'TEXT', text: this.text.outcomeText(done) }]);
  }


}

