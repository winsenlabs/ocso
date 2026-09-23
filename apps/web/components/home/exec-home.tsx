import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { DayList, RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { loadMyAssignments, loadPickupQueue, loadRecentlyResolved } from '@/lib/api/conversations';
import type { ForYouItem, HomeData } from '@/lib/api/home';
import { firstName, formatTime, formatZoneName } from '@/lib/format';
import type { Session } from '@/lib/session';
import type { AskChip } from './ask-ocso-bar';
import { AvailabilityPicker } from './availability-picker';
import { AssignmentsTable, PickupQueueTable } from './conversation-tables';
import { HomeFrame } from './home-frame';
import { execTail } from './home-copy';
import { mergeNeedsYou, periodLabel, type NeedsYouLike } from './home-model';
import { TakeNextButton } from './take-next';

type ServiceHome = Extract<HomeData, { role: 'SERVICE' }>;

/**
 * "For you" items the ranked list may not carry: offers, urgent pickups and
 * alerts, each only when the API list does not already name that
 * conversation or alert (it lists offers as "<customer> is waiting for you").
 */
export function forYouItems(items: readonly ForYouItem[], ranked: readonly NeedsYouLike[]): NeedsYouLike[] {
  const mentioned = (id: string) => ranked.some((r) => r.id.includes(id) || r.href.includes(id));
  return items.flatMap((item): NeedsYouLike[] => {
    switch (item.kind) {
      case 'offer':
        return mentioned(item.conversationId)
          ? []
          : [
              {
                id: `offer:${item.conversationId}`,
                kind: 'offer',
                severity: 'high',
                title: `Offered to you: ${item.customerName ?? 'a customer'}`,
                detail: `${item.priority.toLowerCase()} · accept or decline in the workspace`,
                at: item.waitingSince ?? new Date().toISOString(),
                href: `/conversations/${item.conversationId}`,
              },
            ];
      case 'urgent_pickup':
        return mentioned(item.conversationId)
          ? []
          : [
              {
                id: `pickup:${item.conversationId}`,
                kind: 'escalation_waiting',
                severity: 'high',
                title: `${item.priority} unclaimed: ${item.customerName ?? 'a customer'}`,
                detail: item.reason ?? 'waiting in your queues',
                at: item.waitingSince ?? new Date().toISOString(),
                href: `/conversations/${item.conversationId}`,
              },
            ];
      case 'alert':
        return mentioned(item.alertId)
          ? []
          : [
              {
                id: `alert:${item.alertId}`,
                kind: 'alert',
                severity: item.severity === 'CRITICAL' ? 'critical' : item.severity === 'WARNING' ? 'high' : 'normal',
                title: item.title,
                at: item.openedAt,
                href: `/alerts?alert=${item.alertId}`,
              },
            ];
    }
  });
}

/** Service Home (HOME decision 3): what needs you, take the next conversation, my shift and my queue, small stats. */
export async function ExecHome({ session, home, ask, now }: { session: Session; home: ServiceHome; ask: AskChip[] | null; now: Date }) {
  const [pickup, assigned, resolved] = await Promise.all([
    loadPickupQueue().catch(() => null),
    loadMyAssignments().catch(() => null),
    loadRecentlyResolved().catch(() => null),
  ]);
  const data = home.exec;
  const tz = session.user.deployment.timezone;
  const t = data.tiles;
  const shift = data.shift;
  const queues = shift.queues.map((q) => q.name).join(', ');
  const needsYou = mergeNeedsYou(home.needsYou, forYouItems(data.forYou, home.needsYou));
  const waiting = pickup?.length ?? t.waitingForHuman;
  const nextAvailable = home.service?.nextAvailable ?? waiting > 0;

  const shiftCard = (
    <RailCard title="My shift" count={formatZoneName(tz)}>
      <KeyValue
        template="minmax(86px,96px) minmax(0,1fr)"
        items={[
          { k: 'availability', v: <AvailabilityPicker initial={shift.availability} /> },
          { k: 'capacity', v: `${shift.activeConversations} of ${shift.maxConcurrent} concurrent` },
          { k: 'queues', v: queues || 'no team queue' },
          { k: 'languages', v: shift.languages.length ? shift.languages.join(', ') : '—' },
        ]}
      />
    </RailCard>
  );

  return (
    <HomeFrame
      name={firstName(session.user.name)}
      tail={execTail(t.waitingForHuman)}
      strip={[`${t.assignedToMe} assigned`, `${t.waitingForHuman} in pickup`, `${t.slaBreached} SLA breached`, `times in ${formatZoneName(tz)}`]}
      ask={ask}
      needsYou={needsYou}
      tiles={home.tiles}
      period={periodLabel('SERVICE')}
      setup={home.setup}
      permissions={session.permissions}
      now={now}
      rail={shiftCard}
    >
      <div className="row2">
        <div>
          <SecHead
            title="My queue"
            count={pickup ? `${pickup.length} waiting${queues ? ` · ${queues}` : ''}` : undefined}
            actions={
              <Link className="btn tiny ghost" href="/conversations">
                Open workspace
              </Link>
            }
          />
          <TakeNextButton available={nextAvailable} waiting={waiting} />
          <PickupQueueTable rows={pickup} />
          <SecHead title="Assigned to me" count={assigned ? assigned.length : undefined} style={{ marginTop: 18 }} />
          <AssignmentsTable rows={assigned} timeZone={tz} />
        </div>
        <div className="rail">
          <RailCard title="Recently resolved">
            {resolved === null ? (
              <EmptyState size="sm" title="Could not load">
                Your recently resolved conversations could not be loaded.
              </EmptyState>
            ) : resolved.length === 0 ? (
              <span className="mono-sm">nothing resolved yet</span>
            ) : (
              <DayList
                rows={resolved.map((r) => ({
                  key: r.conversationId,
                  time: formatTime(r.resolvedAt, tz),
                  label: r.customerName,
                  who: r.summary,
                  flag: r.csat === null ? '—' : r.csat.toFixed(1),
                }))}
              />
            )}
          </RailCard>
        </div>
      </div>
    </HomeFrame>
  );
}
