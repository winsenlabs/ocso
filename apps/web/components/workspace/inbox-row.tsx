import Link from 'next/link';
import { ChannelMark } from '@/components/ui/channel-mark';
import { ControlState, controlStateKind } from '@/components/ui/control-state';
import { SlaTimer } from '@/components/ui/sla-timer';
import type { ConversationSummary } from '@/lib/api/conversations';
import type { ChannelMarkView } from '@/lib/channels';
import { formatDateTime, formatTime } from '@/lib/format';
import { controlLabel, customerDisplayName } from './lib/labels';
import { pickupSla, slaLabel } from './lib/sla';
import { RowTags } from './row-tags';

export interface InboxRowProps {
  item: ConversationSummary;
  href: string;
  selected: boolean;
  meId: string;
  timeZone: string;
  now: number;
  /** The inbox tag filter, highlighted on the row. */
  activeTag?: string | null;
  /** The channel kind's mark (descriptor); none for kinds the API does not describe. */
  mark?: ChannelMarkView | null;
}

function when(iso: string, timeZone: string, now: number): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t < 20 * 3_600_000 ? formatTime(iso, timeZone) : formatDateTime(iso, timeZone).slice(0, 6);
}

const PRIO: Readonly<Record<string, string>> = { P1: 'p1', P2: 'p2' };

/** One inbox row (design/01 .crow). */
export function InboxRow({ item, href, selected, meId, timeZone, now, activeTag = null, mark = null }: InboxRowProps) {
  const kind = controlStateKind(item.controlState);
  const sla = pickupSla(item.controlState, item.waitingSince, item.slaDueAt, now);
  return (
    <Link href={href} className={selected ? 'crow on' : 'crow'} aria-current={selected ? 'page' : undefined} data-conversation-id={item.id}>
      <span className={`prio ${PRIO[item.priority] ?? 'p3'}`} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span className="l1">
          <span className="nm">{customerDisplayName(item)}</span>
          {item.customer.name && item.customer.identity ? <span className="ph">{item.customer.identity}</span> : null}
          <time className="tm" dateTime={item.lastInteractionAt}>
            {when(item.lastInteractionAt, timeZone, now)}
          </time>
        </span>
        <span className="l2">
          {mark ? <ChannelMark mark={mark} /> : null}
          <span className="ag">
            {item.agent.name} · {item.agent.conversationType.toLowerCase()}
          </span>
          {PRIO[item.priority] ? (
            <span className="schip muted" style={{ marginLeft: 'auto' }}>
              {item.priority}
            </span>
          ) : null}
        </span>
        <span className="sn">{item.lastPreview ?? item.handoff?.reason ?? 'No messages yet'}</span>
        <RowTags tags={item.tags} activeTag={activeTag} />
        <span className="l3">
          <ControlState state={kind}>{controlLabel(item, meId)}</ControlState>
          {sla ? (
            <SlaTimer level={sla.level} progress={sla.progress} label={slaLabel(sla)} />
          ) : item.controlState === 'RESOLVED' && item.resolvedAt ? (
            <span className="sla">resolved {when(item.resolvedAt, timeZone, now)}</span>
          ) : (
            <span className="sla" title="No SLA clock running">
              —
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
