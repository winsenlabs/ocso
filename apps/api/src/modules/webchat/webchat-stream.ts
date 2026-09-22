import type { MessageEvent } from '@nestjs/common';
import { Observable, concatMap, from, mergeMap } from 'rxjs';
import type { ChannelCapabilities, EmbedVisitor } from '@ocso/channels';
import type { OcsoEvent } from '@ocso/events';
import type { RealtimeHub } from '../realtime/realtime.hub.js';
import type { VisitorConversation, WebChatIdentityService } from './webchat-identity.service.js';
import type { WebChatMessagesService } from './webchat-messages.service.js';
import { modeOf } from './webchat-notices.js';

/**
 * One visitor's live stream (docs/07 §4). Server → widget events:
 * `ready` · `message` (stored customer-visible message) · `delta` (streamed AI
 * text, `turnId`) · `typing` · `idle` (turn finished) · `notice` (customer-safe
 * control change) · `status` (who is driving) · `ping`.
 *
 * Events are handled strictly in order (concatMap): a stored message must
 * never overtake the deltas that preceded it. The visitor's conversation is
 * resolved *after* subscribing to the hub, so a conversation created in
 * between is never missed; afterwards it is re-resolved only when a new
 * conversation is created on this channel for this visitor's customer.
 */

const TYPES: ReadonlySet<string> = new Set([
  'conversation.created',
  'interaction.received',
  'interaction.sent',
  'human.message_sent',
  'agent.response_delta',
  'agent.status',
  'agent.turn_completed',
  'conversation.control_changed',
]);

export interface VisitorStreamDeps {
  hub: RealtimeHub;
  identity: WebChatIdentityService;
  messages: WebChatMessagesService;
}

export interface VisitorStreamInput {
  channelId: string;
  visitor: EmbedVisitor;
  capabilities: ChannelCapabilities;
}

export function visitorStream(deps: VisitorStreamDeps, input: VisitorStreamInput): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let current: VisitorConversation | null = null;
    let customerId: string | null = null;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => (markReady = resolve));

    const handle = async (e: OcsoEvent): Promise<MessageEvent[]> => {
      await ready;
      if (e.type === 'conversation.created') {
        const p = e.payload as { customerId: string; channelId: string | null };
        if (p.channelId !== input.channelId) return [];
        customerId ??= await deps.identity.customerIdFor(input.visitor);
        if (customerId !== p.customerId) return [];
        current = await deps.identity.conversationFor(input.channelId, input.visitor);
        return [];
      }
      if (!current || e.conversationId !== current.id) return [];
      return toCustomerEvents(deps, e, current, input.capabilities);
    };

    const sub = deps.hub
      .stream((e) => TYPES.has(e.type))
      .pipe(
        concatMap((e) => from(handle(e))),
        mergeMap((events) => from(events)),
      )
      .subscribe(subscriber);

    deps.identity.conversationFor(input.channelId, input.visitor).then(
      (conversation) => {
        current = conversation;
        subscriber.next({ type: 'ready', data: { conversationId: conversation?.id ?? null } });
        markReady();
      },
      (err: unknown) => subscriber.error(err),
    );
    return () => sub.unsubscribe();
  });
}

async function toCustomerEvents(deps: VisitorStreamDeps, e: OcsoEvent, conv: VisitorConversation, caps: ChannelCapabilities): Promise<MessageEvent[]> {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'interaction.received': // the customer's own message (e.g. sent from another tab)
    case 'interaction.sent':
    case 'human.message_sent': {
      if (e.type === 'interaction.received' && p['actorType'] !== 'CUSTOMER') return [];
      const message = await deps.messages.one(String(p['interactionId']), caps, conv.agentName);
      return message ? [{ type: 'message', data: message }] : [];
    }
    case 'agent.response_delta':
      return [{ type: 'delta', data: { turnId: p['turnId'], text: p['delta'] } }];
    case 'agent.status':
      return [{ type: 'typing', data: { turnId: p['turnId'], status: p['status'] } }];
    case 'agent.turn_completed':
      return [{ type: 'idle', data: { turnId: p['turnId'] } }];
    case 'conversation.control_changed': {
      const to = String(p['to']);
      conv.controlState = to;
      conv.assignedUserId = to === 'HUMAN_ACTIVE' && typeof p['actorId'] === 'string' ? p['actorId'] : conv.assignedUserId;
      const notice = await deps.messages.latestNotice(conv.id, { from: p['from'], to }, conv.agentName);
      const humanName = to === 'HUMAN_ACTIVE' ? await deps.messages.firstNameOf(conv.assignedUserId) : null;
      const status: MessageEvent = { type: 'status', data: { mode: modeOf(to), humanName } };
      return notice ? [{ type: 'notice', data: notice }, status] : [status];
    }
    default:
      return [];
  }
}
