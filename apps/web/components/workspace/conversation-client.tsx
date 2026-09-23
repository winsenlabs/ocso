'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Permission } from '@ocso/auth';
import { controlAction } from '@/lib/actions/conversations';
import type { ConversationDetail, ConversationTools, CopilotState, CustomerProfile, Option, TimelineItem } from '@/lib/api/conversations';
import { firstName } from '@/lib/format';
import { useRealtime } from '@/lib/realtime/use-realtime';
import { Composer, LockedBar } from './composer';
import { ControlBanner, type DialogKind } from './control-banner';
import { ResolveDialog, ReturnToAiDialog, TransferDialog } from './control-dialogs';
import { ConversationHeader } from './conversation-header';
import { CustomerRail } from './customer-rail';
import { controlView, type ControlView } from './lib/control';
import { useConversationTags } from './lib/use-conversation-tags';
import { useActionRunner } from './lib/use-action';
import { useNow } from './lib/use-now';
import { TemplateComposer } from './template-composer';
import { TimelinePane, type StreamingTurn } from './timeline-pane';

export interface ConversationClientProps {
  me: { id: string; name: string };
  permissions: string[];
  timeZone: string;
  renderedAt: number;
  detail: ConversationDetail;
  timeline: TimelineItem[];
  tools: ConversationTools;
  customer: CustomerProfile | null;
  copilot: CopilotState;
  transferQueues: Option[];
  transferUsers: Option[];
  /** The conversation's channel as its kind describes it (GET /v1/channels/kinds). */
  channelInfo: ChannelInfo;
}

export interface ChannelInfo {
  /** The network's name ("WhatsApp"), else the channel's configured name. */
  label: string;
  /** Set when the kind supports message templates; `reviewer` approves them. */
  templates: { reviewer: string } | null;
}

/**
 * Live conversation pane + rail (design/01). Server data is the source of
 * truth: realtime events for this conversation trigger a debounced refresh;
 * streamed AI deltas render as a typing bubble until the message lands.
 */
export function ConversationClient(props: ConversationClientProps) {
  const { detail, timeline, me, timeZone } = props;
  const router = useRouter();
  const perms = useMemo(() => new Set(props.permissions), [props.permissions]);
  const view = controlView({
    controlState: detail.controlState,
    assignedUserId: detail.assignedUser?.id ?? null,
    handoffStatus: detail.openHandoff?.status ?? null,
    meId: me.id,
    permissions: perms,
  });
  const now = useNow(1_000, props.renderedAt);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [stream, setStream] = useState<(StreamingTurn & { done: boolean }) | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const tags = useConversationTags(detail.id, detail.tags);
  const canTag = perms.has(Permission.CONVERSATIONS_NOTE);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, 250);
  }, [router]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const live = useRealtime({
    conversationId: detail.id,
    onReconnect: refresh,
    onEvent: (event) => {
      switch (event.type) {
        case 'agent.response_delta': {
          const { turnId, delta } = event.payload;
          setStream((s) => (s && s.turnId === turnId ? { ...s, text: s.text + delta } : { turnId, text: delta, done: false }));
          return;
        }
        case 'agent.status':
          setAgentStatus(event.payload.status);
          return;
        case 'agent.turn_started':
          setAgentStatus('THINKING');
          return;
        case 'agent.turn_completed':
          setAgentStatus(null);
          setStream((s) => (s ? { ...s, done: true } : s));
          refresh();
          return;
        default:
          refresh();
      }
    },
  });

  // The streamed bubble gives way to the persisted message after the refresh.
  const lastTimeline = useRef(timeline);
  useEffect(() => {
    if (lastTimeline.current === timeline) return;
    lastTimeline.current = timeline;
    setStream((s) => (s && (s.done || timeline.some((i) => i.kind === 'message' && i.turnId === s.turnId && i.actorType === 'AGENT')) ? null : s));
  }, [timeline]);

  const knownName = detail.customer.name ?? props.customer?.displayName ?? null;
  const customerName = knownName ? firstName(knownName) : 'the customer';
  const channel = props.channelInfo.label;
  const customerTurns = timeline.filter((i) => i.kind === 'message' && i.actorType === 'CUSTOMER').length;
  const passedNotes = timeline.filter((i) => i.kind === 'note' && i.passToAgent).length;
  const canTransfer = view.actions.includes('transfer') && (props.transferQueues.length > 0 || props.transferUsers.length > 0);

  return (
    <>
      <section className="center" aria-label="Conversation">
        <ConversationHeader
          detail={detail}
          channelLabel={channel}
          externalRef={props.customer?.externalRef ?? null}
          meId={me.id}
          timeZone={timeZone}
          tags={tags}
          canTag={canTag}
          onTransfer={canTransfer ? () => setDialog('transfer') : null}
        />
        <ControlBanner detail={detail} view={view} now={now} timeZone={timeZone} customerTurns={customerTurns} passedNotes={passedNotes} onDialog={setDialog} />
        <TimelinePane
          items={timeline}
          detail={detail}
          meId={me.id}
          timeZone={timeZone}
          now={now}
          canConfirm={perms.has(Permission.TOOLS_CONFIRM_SENSITIVE)}
          stream={stream}
          agentStatus={detail.controlState === 'AI_ACTIVE' || detail.controlState === 'AI_RESUMING' ? agentStatus : null}
        />
        {view.canCompose ? (
          <Composer
            conversationId={detail.id}
            customerName={customerName}
            channelLabel={channel}
            agentName={detail.agent.name}
            copilot={props.copilot}
            tools={props.tools.available}
            can={{ reply: perms.has(Permission.CONVERSATIONS_REPLY), note: perms.has(Permission.CONVERSATIONS_NOTE), runTools: perms.has(Permission.TOOLS_EXECUTE_HUMAN) }}
            replyWindow={detail.sessionWindow}
            channelId={detail.channel?.id ?? null}
            templates={props.channelInfo.templates}
            renderedAt={props.renderedAt}
          />
        ) : (
          <Locked detail={detail} view={view} live={live} customerName={customerName} canReply={perms.has(Permission.CONVERSATIONS_REPLY)} templates={props.channelInfo.templates} />
        )}
      </section>
      <CustomerRail detail={detail} customer={props.customer} timeline={timeline} tools={props.tools} meId={me.id} timeZone={timeZone} tags={tags} canTag={canTag} />

      {dialog === 'return' ? <ReturnToAiDialog conversationId={detail.id} agentName={detail.agent.name} passedNotes={passedNotes} onClose={() => setDialog(null)} /> : null}
      {dialog === 'resolve' ? <ResolveDialog conversationId={detail.id} currentTags={tags.tags} onClose={() => setDialog(null)} /> : null}
      {dialog === 'transfer' ? (
        <TransferDialog conversationId={detail.id} queues={props.transferQueues} users={props.transferUsers} currentQueueId={detail.queue?.id ?? null} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

/**
 * Locked composer (design/01): why this human cannot write, and the one
 * action that changes that. A resolved conversation on a channel with
 * message templates can also be reopened by sending an approved template
 * (reopen-and-send, docs/09 §4).
 */
function Locked({
  detail,
  view,
  live,
  customerName,
  canReply,
  templates,
}: {
  detail: ConversationDetail;
  view: ControlView;
  live: string;
  customerName: string;
  canReply: boolean;
  templates: ChannelInfo['templates'];
}) {
  const { pending, error, run } = useActionRunner();
  const [withTemplate, setWithTemplate] = useState(false);
  const templateReopen = detail.controlState === 'RESOLVED' && templates !== null && detail.channel !== null && canReply && view.actions.includes('reopen');
  const agent = detail.agent.name;
  const cmd = (c: 'claim' | 'accept' | 'take-over' | 'cancel-return' | 'reopen', label: string) =>
    view.actions.includes(c) ? { label, onClick: () => void run(() => controlAction(detail.id, c)), disabled: pending } : null;
  let text: string;
  let action: { label: string; onClick: () => void; disabled?: boolean } | null = null;
  switch (detail.controlState) {
    case 'AI_ACTIVE':
    case 'ESCALATION_REQUESTED':
      text = `${agent} owns this conversation. Take over to reply as a human.`;
      action = cmd('take-over', 'Take over');
      break;
    case 'WAITING_FOR_HUMAN':
      text = view.offeredToMe
        ? 'This conversation is offered to you. Accept it to reply.'
        : detail.assignedUser
          ? `Offered to ${detail.assignedUser.name}.`
          : `Claim this conversation to reply.${detail.queue ? ` Anyone in ${detail.queue.name} can pick it up.` : ''}`;
      action = cmd('accept', 'Accept') ?? cmd('claim', 'Claim');
      break;
    case 'HUMAN_ACTIVE':
      text = `${detail.assignedUser ? firstName(detail.assignedUser.name) : 'A colleague'} is handling this conversation.`;
      break;
    case 'AI_RESUMING':
      text = `Control is going back to ${agent}. Cancel the return to keep replying.`;
      action = cmd('cancel-return', 'Cancel return');
      break;
    case 'RESOLVED':
      text = 'Resolved. Reopen to reply again.';
      action = cmd('reopen', 'Reopen');
      break;
    case 'ROUTING':
      text = 'A router is asking the customer where they need to go; an agent takes over once it has decided.';
      break;
  }
  return (
    <>
      {error ? (
        <div className="alert error" role="alert" style={{ margin: '0 20px 8px' }}>
          <span>{error}</span>
        </div>
      ) : null}
      {withTemplate && detail.channel ? (
        <div className="comp">
          <div className="modes">
            <b className="mono-sm">Reopen with a template</b>
            <span className="sp" style={{ flex: 1 }} />
            <button type="button" className="btn tiny ghost" onClick={() => setWithTemplate(false)}>
              Cancel
            </button>
          </div>
          <TemplateComposer conversationId={detail.id} channelId={detail.channel.id} customerName={customerName} reopen reviewer={templates?.reviewer} onSent={() => setWithTemplate(false)} />
        </div>
      ) : (
        <LockedBar
          text={live === 'closed' ? `${text} Live updates are off — reload to see changes.` : text}
          action={action}
          secondary={templateReopen ? { label: 'Reopen with a template', onClick: () => setWithTemplate(true), disabled: pending } : null}
        />
      )}
    </>
  );
}
