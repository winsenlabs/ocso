import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { DayList, RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadMyAssignments, loadPickupQueue, loadRecentlyResolved } from '@/lib/api/conversations';
import type { ExecHomeData, ForYouItem } from '@/lib/api/home';
import { firstName, formatAge, formatDuration, formatNumber, formatTime, formatZoneName } from '@/lib/format';
import type { Session } from '@/lib/session';
import { AlertList, type RailAlert } from './alert-list';
import { AvailabilityPicker } from './availability-picker';
import { AssignmentsTable, PickupQueueTable } from './conversation-tables';
import { Greeting } from './greeting';
import { execTail } from './home-copy';

const warnIf = (value: number) => (value > 0 ? { tone: 'warn' as const } : {});

function forYou(item: ForYouItem): RailAlert {
  switch (item.kind) {
    case 'offer':
      return {
        key: `offer-${item.conversationId}`,
        title: `Offered to you: ${item.customerName ?? 'a customer'}`,
        body: `${item.priority}${item.waitingSince ? ` · waiting ${formatAge(item.waitingSince)}` : ''} · accept or decline in the workspace`,
        tone: 'warn',
        href: `/conversations/${item.conversationId}`,
      };
    case 'urgent_pickup':
      return {
        key: `urgent-${item.conversationId}`,
        title: `${item.priority} unclaimed${item.waitingSince ? ` ${formatAge(item.waitingSince)}` : ''}: ${item.customerName ?? 'a customer'}`,
        body: item.reason ?? 'waiting in your queues',
        tone: 'warn',
        href: `/conversations/${item.conversationId}`,
      };
    case 'alert':
      return {
        key: `alert-${item.alertId}`,
        title: item.title,
        body: `${item.severity.toLowerCase()} · opened ${formatAge(item.openedAt)} ago`,
        tone: item.severity === 'CRITICAL' ? 'error' : item.severity === 'WARNING' ? 'warn' : 'info',
        href: `/alerts?alert=${item.alertId}`,
      };
  }
}

/** Service member home (design/06): tiles, shift and "for you" from GET /v1/home; the conversation tables from the inbox API. */
export async function ExecHome({ session, data }: { session: Session; data: ExecHomeData }) {
  const [pickup, assigned, resolved] = await Promise.all([
    loadPickupQueue().catch(() => null),
    loadMyAssignments().catch(() => null),
    loadRecentlyResolved().catch(() => null),
  ]);
  const tz = session.user.deployment.timezone;
  const t = data.tiles;
  const shift = data.shift;
  const queues = shift.queues.map((q) => q.name).join(', ');
  const items = data.forYou.map(forYou);

  return (
    <>
      <Greeting
        name={firstName(session.user.name)}
        tail={execTail(t.waitingForHuman)}
        strip={[
          `${t.assignedToMe} assigned`,
          `${t.waitingForHuman} in pickup`,
          `${t.slaBreached} SLA breached`,
          queues || 'no team queue',
          `times in ${formatZoneName(tz)}`,
        ]}
      />
      <Tiles>
        <Tile label="assigned to me" value={formatNumber(t.assignedToMe)} />
        <Tile label="waiting for human" value={formatNumber(t.waitingForHuman)} {...warnIf(t.waitingForHuman)} />
        <Tile label="sla breached" value={formatNumber(t.slaBreached)} {...warnIf(t.slaBreached)} />
        <Tile label="resolved today" value={formatNumber(t.resolvedToday)} />
        <Tile label="my first response" value={t.myFirstResponseMedianSeconds === null ? null : formatDuration(t.myFirstResponseMedianSeconds)} />
        <Tile label="my csat · 7d" value={t.myCsat7d.average === null ? null : formatNumber(t.myCsat7d.average, 1)} />
      </Tiles>

      <div className="row2">
        <div>
          <SecHead
            title="Pickup queue"
            count={pickup ? `${pickup.length} waiting${queues ? ` · ${queues}` : ''}` : undefined}
            actions={
              <Link className="btn tiny accent" href="/conversations">
                Open workspace
              </Link>
            }
          />
          <PickupQueueTable rows={pickup} />
          <SecHead title="Assigned to me" count={assigned ? assigned.length : undefined} style={{ marginTop: 18 }} />
          <AssignmentsTable rows={assigned} timeZone={tz} />
        </div>

        <div className="rail">
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
          <RailCard title="For you" count={items.length || undefined}>
            <AlertList items={items} empty="nothing needs you right now" />
          </RailCard>
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
    </>
  );
}
