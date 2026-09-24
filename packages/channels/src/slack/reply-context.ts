import type { ReplyContext } from '../contract/types.js';

/**
 * Where a Slack reply goes (stored with each inbound message, handed back on
 * send): the conversation (`D…` DM, `C…`/`G…` channel) and, for threads, the
 * parent message `ts`. Delivery only hands back contexts from this channel's own
 * inbound messages, so one bot token (one workspace) never sees another's.
 */

export interface SlackReplyContext {
  teamId: string;
  channel: string;
  threadTs?: string | undefined;
}

const CONVERSATION = /^[CDG][A-Z0-9]{2,30}$/;
const TS = /^\d{1,12}\.\d{1,9}$/;

export function slackReplyContext(value: SlackReplyContext): ReplyContext {
  return value.threadTs ? { teamId: value.teamId, channel: value.channel, threadTs: value.threadTs } : { teamId: value.teamId, channel: value.channel };
}

/** A stored reply context, when it is well formed. */
export function readSlackReplyContext(context: ReplyContext | undefined): SlackReplyContext | null {
  const channel = context?.['channel'];
  const teamId = context?.['teamId'] ?? '';
  if (!channel || !CONVERSATION.test(channel)) return null;
  const threadTs = context['threadTs'];
  return threadTs && TS.test(threadTs) ? { teamId, channel, threadTs } : { teamId, channel };
}

export const isSlackConversationId = (value: string): boolean => CONVERSATION.test(value);
