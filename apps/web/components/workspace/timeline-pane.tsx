'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { SystemEvent, TimelineEvent, ToolEvent } from '@/components/ui/timeline';
import type { ConversationDetail, TimelineItem } from '@/lib/api/conversations';
import { formatTime, initials } from '@/lib/format';
import { ConfirmCard } from './confirm-card';
import { toolDot, toolMeta, factsOf } from './lib/timeline';
import { MessageParts } from './message-parts';

export interface StreamingTurn {
  turnId: string;
  text: string;
}

export interface TimelinePaneProps {
  items: TimelineItem[];
  detail: ConversationDetail;
  meId: string;
  timeZone: string;
  now: number;
  canConfirm: boolean;
  stream: StreamingTurn | null;
  agentStatus: string | null;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  THINKING: 'is thinking',
  CALLING_TOOL: 'is calling a tool',
  WRITING: 'is writing',
  WAITING_CONFIRMATION: 'is waiting for a human to confirm an action',
};

const hhmm = formatTime;
function hhmmss(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(iso));
  } catch {
    return formatTime(iso, 'UTC');
  }
}

/**
 * Staff timeline (design/01 centre): customer, AI and human turns with
 * multimodal parts, internal system events, tool events, pending sensitive
 * confirmations and internal notes (visibly internal, never customer-facing).
 */
export function TimelinePane({ items, detail, meId, timeZone, now, canConfirm, stream, agentStatus }: TimelinePaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const customerName = detail.customer.name ?? 'Customer';
  const agent = detail.agent.name;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items.length, stream?.text]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="tlwrap" ref={ref}>
      <div className="tl" role="log" aria-label="Conversation timeline" aria-live="polite">
        <SystemEvent>
          conversation opened · {detail.channel?.name ?? 'no channel'} · {agent}
          {detail.promptVersion ? ` v${detail.promptVersion.version}` : ''}
          {detail.modelProfile ? ` · model ${detail.modelProfile.name}` : ''} · {hhmmss(detail.openedAt, timeZone)}
        </SystemEvent>
        {items.map((item) => {
          switch (item.kind) {
            case 'message': {
              const outbound = item.actorType !== 'CUSTOMER';
              const delivery =
                outbound && item.deliveryStatus === 'FAILED' ? (
                  <span className="dl fail">not delivered{item.deliveryError ? ` · ${item.deliveryError}` : ''}</span>
                ) : outbound && item.deliveryStatus !== 'NOT_APPLICABLE' ? (
                  <span className="dl">{item.deliveryStatus.toLowerCase()}</span>
                ) : null;
              const common = { time: hhmm(item.at, timeZone), dateTime: item.at };
              if (item.actorType === 'CUSTOMER') {
                return (
                  <TimelineEvent key={item.id} {...common} kind="cust" who={initials(customerName)} author={customerName} role="customer">
                    <MessageParts parts={item.parts} />
                  </TimelineEvent>
                );
              }
              if (item.actorType === 'ROUTER') {
                return (
                  <TimelineEvent key={item.id} {...common} kind="ai" who="RT" author="Router" role="automated menu">
                    <MessageParts parts={item.parts} />
                    {delivery}
                  </TimelineEvent>
                );
              }
              if (item.actorType === 'AGENT') {
                // A conversation can change agent on a queue transfer: each message shows its own agent.
                const author = item.actorName ?? agent;
                return (
                  <TimelineEvent key={item.id} {...common} kind="ai" who={initials(author)} author={author} role={`virtual agent · ${detail.agent.conversationType.toLowerCase()}`}>
                    <MessageParts parts={item.parts} />
                    {delivery}
                  </TimelineEvent>
                );
              }
              const author = item.actorName ?? 'Human';
              return (
                <TimelineEvent key={item.id} {...common} kind="hum" who={initials(author)} author={author} role={item.actorId === meId ? 'human · you' : 'human'}>
                  <MessageParts parts={item.parts} />
                  {delivery}
                </TimelineEvent>
              );
            }
            case 'system':
              return (
                <SystemEvent key={item.id} highlight={item.data['command'] === 'REQUEST_ESCALATION'}>
                  {item.text || item.schema} · {hhmmss(item.at, timeZone)}
                </SystemEvent>
              );
            case 'note':
              return (
                <TimelineEvent
                  key={item.id}
                  kind="note"
                  who={initials(item.authorName)}
                  author={item.authorName}
                  role={`internal note · not sent to customer${item.passToAgent ? ' · passed to agent' : ''}`}
                  time={hhmm(item.at, timeZone)}
                  dateTime={item.at}
                >
                  <span style={{ whiteSpace: 'pre-wrap' }}>{item.body}</span>
                </TimelineEvent>
              );
            case 'tool':
              if (item.status === 'AWAITING_CONFIRMATION') {
                return (
                  <ConfirmCard
                    key={item.id}
                    agentName={agent}
                    now={now}
                    canDecide={canConfirm}
                    call={{ id: item.id, toolName: item.toolName, connectionName: item.connectionName, riskClass: item.riskClass, args: item.args, reason: item.decisionReason, expiresAt: item.expiresAt, requestedBy: item.actorType }}
                  />
                );
              }
              return (
                <ToolEvent
                  key={item.id}
                  name={item.toolName}
                  meta={toolMeta(item)}
                  status={toolDot(item.status)}
                  facts={[...factsOf(item.summary), ...(item.status === 'DENIED' && item.decisionReason ? [{ k: 'reason', v: item.decisionReason }] : [])]}
                />
              );
          }
        })}
        {stream ? (
          <div className="ev ai streaming" aria-live="off">
            <span className="who" aria-hidden="true">
              {initials(agent)}
            </span>
            <span className="bd">
              <span className="hd">
                <span className="a">{agent}</span>
                <span className="r">virtual agent · writing</span>
              </span>
              <span className="tx">{stream.text}</span>
            </span>
          </div>
        ) : agentStatus ? (
          <SystemEvent>
            {agent.toLowerCase()} {STATUS_TEXT[agentStatus] ?? 'is working'}
          </SystemEvent>
        ) : null}
      </div>
    </div>
  );
}
