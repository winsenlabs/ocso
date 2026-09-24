import type { TeamsActivity } from './activity.js';

/**
 * The Bot Framework conversation reference OCSO keeps with each inbound
 * message (`InboundMessage.replyContext`) and gets back for replies
 * (`OutboundTarget.replyContext`): where to POST (`serviceUrl`, re-checked
 * against the allowlist at send time) and which conversation (a personal chat,
 * a group chat, or a channel thread — `…;messageid=<root>`, so a post to it
 * lands in that thread). Replies go to the chat or thread the person last
 * wrote in.
 *
 * It names the conversation, never the message: no activity id. The same chat
 * or thread therefore gives the same context message after message, which is
 * what core keys on (an Ask OCSO thread per chat thread), and a reply is a new
 * message in the conversation rather than a reply to one activity.
 */

export interface TeamsReplyContext {
  serviceUrl: string;
  conversationId: string;
  conversationType: string;
  tenantId: string;
  botId: string;
}

export function toReplyContext(activity: TeamsActivity, tenantId: string): Record<string, string> {
  const context: TeamsReplyContext = {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation!.id,
    conversationType: activity.conversation!.conversationType ?? 'personal',
    tenantId,
    botId: activity.recipient!.id,
  };
  return { ...context };
}

/** The reference from an outbound target, or null when there is none. */
export function fromReplyContext(context: Readonly<Record<string, string>> | undefined): TeamsReplyContext | null {
  if (!context) return null;
  const { serviceUrl, conversationId, conversationType, tenantId, botId } = context;
  if (!serviceUrl || !conversationId) return null;
  return { serviceUrl, conversationId, conversationType: conversationType ?? 'personal', tenantId: tenantId ?? '', botId: botId ?? '' };
}
