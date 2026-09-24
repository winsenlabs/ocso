import type { TeamsReplyContext } from './reply-context.js';

/**
 * The personal (1:1) chat each Teams person last wrote to the bot from, per channel, as the inbound
 * parser saw it: where a send with no reply context goes (text only that person may read, such as a
 * one-time link, must never go to the group chat or channel thread they wrote in). Process memory
 * only, bounded and short-lived: the send that needs it follows the inbound message in the same
 * process. Unknown person → OCSO cannot write to them privately (a bot starts a Teams chat only
 * through proactive installation, which v1 does not do), and the send fails.
 */

const MAX_ENTRIES = 10_000;
const TTL_MS = 24 * 3_600_000;

export class PersonalChats {
  private readonly chats = new Map<string, { context: TeamsReplyContext; at: number }>();

  constructor(private readonly clock: () => number) {}

  remember(channelId: string, identityValue: string, context: TeamsReplyContext): void {
    if (context.conversationType !== 'personal') return;
    const key = `${channelId}\n${identityValue}`;
    this.chats.delete(key);
    this.chats.set(key, { context, at: this.clock() });
    while (this.chats.size > MAX_ENTRIES) this.chats.delete(this.chats.keys().next().value!);
  }

  find(channelId: string, identityValue: string): TeamsReplyContext | null {
    const key = `${channelId}\n${identityValue}`;
    const entry = this.chats.get(key);
    if (!entry) return null;
    if (this.clock() - entry.at > TTL_MS) {
      this.chats.delete(key);
      return null;
    }
    return entry.context;
  }
}
