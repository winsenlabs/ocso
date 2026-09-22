import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { DayList, RailCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { Tile, Tiles } from '@/components/ui/tile';
import { loadOpenAlerts } from '@/lib/api/alerts';
import { loadExecMetrics, loadMyAssignments, loadPickupQueue, loadRecentlyResolved } from '@/lib/api/conversations';
import { firstName, formatDuration, formatNumber, formatTime, formatZoneName } from '@/lib/format';
import type { Session } from '@/lib/session';
import { AlertList } from './alert-list';
import { AvailabilityPicker } from './availability-picker';
import { AssignmentsTable, PickupQueueTable } from './conversation-tables';
import { Greeting } from './greeting';

/** CS Exec home (design/06): pickup queue, own workload and shift. */
export async function ExecHome({ session, teamLabel }: { session: Session; teamLabel: string | null }) {
  const [metrics, pickup, assigned, resolved, alerts] = await Promise.all([
    loadExecMetrics(),
    loadPickupQueue(),
    loadMyAssignments(),
    loadRecentlyResolved(),
    loadOpenAlerts(),
  ]);
  const tz = session.user.deployment.timezone;
  const tail =
    pickup === null
      ? 'your pickup queue appears here once conversations are connected.'
      : pickup.length === 0
        ? 'nobody is waiting on a human.'
        : `${pickup.length} ${pickup.length === 1 ? 'customer is' : 'customers are'} waiting on a human.`;

  return (
    <>
      <Greeting
        name={firstName(session.user.name)}
        tail={tail}
        strip={[session.roleLabel, teamLabel ?? 'no team assigned', `times in ${tz} (${formatZoneName(tz)})`]}
      />
      <Tiles>
        <Tile label="assigned to me" value={metrics ? formatNumber(metrics.assignedToMe) : null} />
        <Tile label="waiting for human" value={metrics ? formatNumber(metrics.waitingForHuman) : null} {...warnIf(metrics?.waitingForHuman)} />
        <Tile label="sla breached" value={metrics ? formatNumber(metrics.slaBreached) : null} {...warnIf(metrics?.slaBreached)} />
        <Tile label="resolved today" value={metrics ? formatNumber(metrics.resolvedToday) : null} />
        <Tile label="my first response" value={metrics ? formatDuration(metrics.firstResponseSeconds) : null} />
        <Tile label="my csat · 7d" value={metrics ? formatNumber(metrics.csat7d, 1) : null} />
      </Tiles>

      <div className="row2">
        <div>
          <SecHead
            title="Pickup queue"
            count={pickup ? `${pickup.length} waiting${teamLabel ? ` · ${teamLabel}` : ''}` : 'no data yet'}
            actions={
              <Link className="btn tiny accent" href="/conversations">
                Open workspace
              </Link>
            }
          />
          <PickupQueueTable rows={pickup} />
          <SecHead title="Assigned to me" count={assigned ? assigned.length : 'no data yet'} style={{ marginTop: 18 }} />
          <AssignmentsTable rows={assigned} timeZone={tz} />
        </div>

        <div className="rail">
          <RailCard title="My shift" count={formatZoneName(tz)}>
            <KeyValue
              template="minmax(86px,96px) minmax(0,1fr)"
              items={[
                { k: 'availability', v: <AvailabilityPicker /> },
                { k: 'queues', v: teamLabel ?? 'no team assigned' },
                { k: 'timezone', v: tz },
              ]}
            />
          </RailCard>
          <RailCard title="For you" count={alerts ? alerts.length : undefined}>
            <AlertList alerts={alerts} emptyText="Alerts addressed to CS Execs — unclaimed hardship cases, policy updates — will appear here." />
          </RailCard>
          <RailCard title="Recently resolved">
            {resolved === null ? (
              <EmptyState size="sm" title="No data yet">
                Conversations you resolve today will be listed here with their CSAT.
              </EmptyState>
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

function warnIf(value: number | undefined): { tone?: 'warn' } {
  return value !== undefined && value > 0 ? { tone: 'warn' } : {};
}
