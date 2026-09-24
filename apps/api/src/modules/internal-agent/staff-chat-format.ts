import type { Logger } from '@nestjs/common';
import type { ChannelAdapter, ChannelRuntimeConfig, InboundMessage, OutboundMediaResolver, ReplyContext } from '@ocso/channels';
import { DomainError, choicesPart, type InteractionPart } from '@ocso/domain';
import { capabilityByName, type ActionCard, type ObjectLink, type ToolAnswer } from '@ocso/internal-agent';

/** Staff chat (Ask OCSO over Slack, Teams): replying through the channel's adapter, and cards and answers as chat text. */

/** The option id a card button carries: `ocso-card:<card id>:confirm|cancel`. */
const CARD_OPTION = /^ocso-card:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(confirm|cancel)$/;
export const cardOptionId = (cardId: string, decision: 'confirm' | 'cancel') => `ocso-card:${cardId}:${decision}`;

/** Staff chat sends text and buttons only: nothing asks an adapter for media. */
const NO_MEDIA: OutboundMediaResolver = {
  signedUrl: () => Promise.reject(new Error('staff chat sends no media')),
  read: () => Promise.reject(new Error('staff chat sends no media')),
};

/** Where one inbound message came from, and how to answer it through the channel's own adapter. */
export class ChatReply {
  constructor(
    private readonly adapter: ChannelAdapter,
    private readonly config: ChannelRuntimeConfig,
    private readonly message: InboundMessage,
    private readonly logger: Logger,
  ) {}

  text(text: string): Promise<boolean> {
    return this.send([{ type: 'TEXT', text }]);
  }

  /**
   * Text only the sender may read (a one-time link): sent to them directly, with no reply context (a Slack DM, their
   * Teams personal chat), never into the chat they wrote in, which may be a shared channel or group chat. When the
   * channel cannot reach them directly, `notice` (nothing secret) goes where they wrote instead. Resolves whether the
   * private text was delivered.
   */
  async private(text: string, notice: string): Promise<boolean> {
    const parts: InteractionPart[] = [{ type: 'TEXT', text }];
    if (!this.message.replyContext) return this.deliver(parts, undefined, false);
    if (await this.deliver(parts, undefined, true)) return true;
    await this.deliver([{ type: 'TEXT', text: notice }], this.message.replyContext, false);
    return false;
  }

  /** Render through the adapter (Slack mrkdwn and Block Kit, Teams markdown and Adaptive Cards) and send where the sender wrote. */
  send(parts: InteractionPart[]): Promise<boolean> {
    return this.deliver(parts, this.message.replyContext, false);
  }

  private async deliver(parts: InteractionPart[], replyContext: ReplyContext | undefined, quiet: boolean): Promise<boolean> {
    const target = {
      identityKind: this.message.identityKind,
      identityValue: this.message.identityValue,
      ...(this.message.channelAccountId ? { channelAccountId: this.message.channelAccountId } : {}),
      lastInboundAt: this.message.receivedAt,
      ...(replyContext ? { replyContext } : {}),
    };
    for (const rendered of this.adapter.render(parts, this.config)) {
      const result = await this.adapter.send(target, rendered, this.config, NO_MEDIA);
      if (!result.ok) {
        if (!quiet) this.logger.warn(`staff chat reply not sent on channel ${this.config.id}: ${result.errorCode} ${result.message}`);
        return false;
      }
    }
    return true;
  }
}

/** The card as chat text; names and values people typed cannot form links or emphasis. */
export function cardText(card: ActionCard): string {
  const lines = [`**${plain(card.title)}**`];
  if (card.summary) lines.push(plain(card.summary));
  for (const c of card.changes.slice(0, 12)) lines.push(`• ${plain(c.label)}: ${c.before === null ? '' : `${code(c.before)} → `}${code(c.after)}`);
  if (card.changes.length > 12) lines.push(`… and ${card.changes.length - 12} more changes`);
  for (const w of card.warnings.slice(0, 5)) lines.push(`⚠ ${plain(w)}`);
  return lines.join('\n');
}

/** Only direct and stop cards without credential fields or a revealed secret are confirmed from chat. */
export function confirmableInChat(card: ActionCard): boolean {
  if (card.kind === 'governed' || card.credentials?.length) return false;
  return !capabilityByName(card.tool)?.revealResponse;
}

/** Text from people and objects: no link or code syntax survives (a name cannot turn into a link). */
export function plain(text: string): string {
  return text.replace(/[[\]`]/g, (c) => (c === '[' ? '(' : c === ']' ? ')' : "'"));
}

export function code(value: string): string {
  const v = value.replace(/`/g, "'").replace(/\n/g, ' ').slice(0, 300);
  return v ? `\`${v}\`` : '(empty)';
}

export function textOf(parts: readonly InteractionPart[]): string {
  return parts
    .flatMap((p) => (p.type === 'TEXT' ? [p.text] : []))
    .join('\n')
    .trim()
    .slice(0, 4_000);
}

/** A tapped card button (a STRUCTURED reply whose option id is `ocso-card:<id>:confirm|cancel`). */
export function cardClick(parts: readonly InteractionPart[]): { cardId: string; decision: 'confirm' | 'cancel' } | null {
  for (const part of parts) {
    if (part.type !== 'STRUCTURED') continue;
    const id = (part.data as { id?: unknown } | null)?.id;
    const match = typeof id === 'string' ? CARD_OPTION.exec(id) : null;
    if (match) return { cardId: match[1]!, decision: match[2] as 'confirm' | 'cancel' };
  }
  return null;
}

export function failureText(err: unknown): string {
  if (err instanceof DomainError && ['validation', 'authorization', 'conflict', 'not_found', 'policy_denied'].includes(err.category)) return plain(err.message);
  return 'Ask OCSO could not answer right now. Try again in a moment.';
}

/** What one Ask OCSO turn produced, collected from its sink. */
export interface Answer {
  text: string;
  links: ObjectLink[];
  tables: Array<NonNullable<ToolAnswer['table']>>;
  cards: ActionCard[];
  denied: string[];
}

/** An Ask OCSO answer, card or card outcome as chat parts, with in-app links made absolute on the OCSO origin. */
export class ChatText {
  constructor(private readonly origin: string) {}

  answerParts(answer: Answer, threadId: string): InteractionPart[] {
    const lines: string[] = [];
    const text = this.absolute(answer.text.trim());
    if (text) lines.push(text);
    for (const message of answer.denied) lines.push(`Not allowed: ${plain(message)}`);
    for (const table of answer.tables.slice(0, 2)) {
      lines.push('', table.columns.map(plain).join(' · '));
      for (const r of table.rows.slice(0, 15)) lines.push(`• ${r.map((c) => plain(String(c))).join(' · ')}`);
      if (table.rows.length > 15) lines.push(`… and ${table.rows.length - 15} more`);
    }
    const seen = new Set<string>();
    const links = answer.links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 10);
    if (links.length) lines.push('');
    for (const l of links) lines.push(`• [${plain(l.label)}](${this.url(l.href)})${l.detail ? ` · ${plain(l.detail)}` : ''}`);
    const parts: InteractionPart[] = [];
    const body = lines.join('\n').trim();
    if (body) parts.push({ type: 'TEXT', text: body });
    for (const card of answer.cards) parts.push(...this.cardParts(card, threadId));
    if (!parts.length) parts.push({ type: 'TEXT', text: 'I have no answer to that. Try asking another way.' });
    return parts;
  }

  /** Direct and stop cards: the card as text with Confirm / Cancel buttons. Governed and credential cards: a link into OCSO. */
  cardParts(card: ActionCard, threadId: string): InteractionPart[] {
    const body = cardText(card);
    if (confirmableInChat(card)) {
      return [
        choicesPart({
          text: body.slice(0, 3_900),
          options: [
            { id: cardOptionId(card.id, 'confirm'), label: 'Confirm' },
            { id: cardOptionId(card.id, 'cancel'), label: 'Cancel' },
          ],
        }),
      ];
    }
    const why = card.kind === 'governed' ? 'This change needs a checker and a reason, so it is sent for approval in OCSO' : 'This one asks for values you type into OCSO itself, never into chat';
    return [{ type: 'TEXT', text: `${body}\n\n${why}: [Open in OCSO](${this.openCard(threadId)})` }];
  }

  outcomeText(card: ActionCard): string {
    const title = plain(card.title);
    const message = card.result?.message ? plain(card.result.message) : null;
    const lead =
      card.status === 'EXECUTED'
        ? (message ?? `Done: ${title}.`)
        : card.status === 'SUBMITTED'
          ? (message ?? `Sent for approval: ${title}.`)
          : card.status === 'REJECTED'
            ? `Cancelled: ${title}. Nothing changed.`
            : card.status === 'EXPIRED'
              ? `This card expired: ${title}. Ask again to see the current values.`
              : (message ?? `${title}: ${card.status.toLowerCase()}.`);
    return card.result?.href ? `${lead}\n[Open in OCSO](${this.url(card.result.href)})` : lead;
  }

  /** The drawer opened on the thread holding the card (it renders cards by id with their current state). */
  openCard(threadId: string): string {
    return `${this.origin}/?askOcso=${threadId}`;
  }

  /** An in-app path (`/agents/…`) as an absolute OCSO URL; anything else is left as it is. */
  url(href: string): string {
    return href.startsWith('/') && !href.startsWith('//') ? `${this.origin}${href}` : href;
  }

  /**
   * Links in the model's answer: in-app paths become absolute OCSO URLs and stay links; a link anywhere else is
   * reduced to its label with the target shown as code (never clickable, never relabelled). The model reads text
   * customers wrote, so a prompt injection must not make the OCSO bot post a disguised link into staff chat (the
   * drawer renders no links from model text at all). Reference-style link definitions are neutralized the same way.
   */
  absolute(text: string): string {
    return text
      .replace(/\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"\n]*")?\)/g, (_m, label: string, target: string) => {
        const url = this.url(target.replace(/^<(.*)>$/, '$1'));
        return this.ours(url) ? `[${label}](${url})` : `${label} (${code(target)})`;
      })
      .replace(/^( {0,3})\[([^\]\n]+)\]:\s*(\S+).*$/gm, (_m, indent: string, label: string, target: string) => `${indent}${label}: ${code(target)}`);
  }

  /** An absolute URL on this OCSO origin. */
  private ours(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }
}
