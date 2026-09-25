import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { MetricTile } from '@/components/analytics/parts';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { AlertBanner } from '@/components/ui/alert-banner';
import { SecHead } from '@/components/ui/sec-head';
import { Tiles } from '@/components/ui/tile';
import { loadQueueAnalytics } from '@/lib/api/analytics';
import { loadInbox } from '@/lib/api/conversations';
import { listQueues, listSlaPolicies } from '@/lib/api/queues';
import { formatNumber } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { countSla, liveSla } from './sla-live';
import { SlaManager } from './sla-manager';
import { WaitingList } from './waiting-list';
import { toWaitingRows } from './waiting-rows';

const LIVE_DEFINITION =
  'Conversations waiting for a human (ESCALATION_REQUESTED / WAITING_FOR_HUMAN) with a pickup due time: breached = past sla_due_at now; at risk = elapsed share of the pickup window ≥ the queue policy’s at-risk fraction.';

/** SLA policies and the live pickup clock (docs/archive/specs/09, design/02 Routing tab SLA card). */
export async function SlaBody() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.QUEUES_READ)) return <NotPermitted role={session.roleLabel} />;
  const seesAll = hasPermission(session, Permission.CONVERSATIONS_READ_TEAM);
  const seesAnalytics = hasPermission(session, Permission.ANALYTICS_BUSINESS_READ);
  const [policies, queues, inbox, analytics] = await Promise.all([
    listSlaPolicies(),
    listQueues(),
    seesAll ? loadInbox({ view: 'waiting', limit: 200 }) : Promise.resolve(null),
    seesAnalytics ? loadQueueAnalytics(7) : Promise.resolve(null),
  ]);
  const fractions: Record<string, number> = {};
  for (const q of queues) {
    const p = policies.find((x) => x.id === q.slaPolicyId);
    if (p) fractions[q.id] = p.atRiskFraction;
  }
  const now = Date.now();
  const rows = inbox ? toWaitingRows(inbox.items) : [];
  const counts = countSla(rows.map((r) => ({ sla: liveSla(r, (r.queueId ? fractions[r.queueId] : undefined) ?? 0.75, now) })));
  const breaches7d = analytics ? analytics.queues.reduce((s, q) => s + q.slaBreachesInWindow, 0) : null;
  const unattached = queues.filter((q) => !q.slaPolicyId);

  return (
    <>
      {inbox ? (
        <Tiles>
          <MetricTile label="waiting now" value={formatNumber(counts.waiting)} definition={LIVE_DEFINITION} note={undefined} caption={`${counts.withSla} with a pickup clock`} />
          <MetricTile label="at risk now" value={formatNumber(counts.risk)} definition={LIVE_DEFINITION} note={undefined} tone={counts.risk > 0 ? 'warn' : undefined} />
          <MetricTile label="breached now" value={formatNumber(counts.breach)} definition={LIVE_DEFINITION} note={undefined} tone={counts.breach > 0 ? 'warn' : undefined} />
          {analytics && breaches7d !== null ? (
            <MetricTile label="breaches · 7d" value={formatNumber(breaches7d)} definition={analytics.definitions['slaBreachesInWindow'] ?? ''} note={undefined} caption="conversations opened in 7d" />
          ) : null}
        </Tiles>
      ) : null}

      {unattached.length && queues.length ? (
        <AlertBanner tone="warn" title={`${unattached.length} queue${unattached.length === 1 ? '' : 's'} without an SLA policy`}>
          {unattached.map((q) => q.name).join(', ')} — handoffs routed there get no pickup clock and never count as breaches.{' '}
          {hasPermission(session, Permission.QUEUES_MANAGE) ? <Link href="/queues">Attach a policy on Queues.</Link> : null}
        </AlertBanner>
      ) : null}

      <SlaManager
        policies={policies.map((p) => ({ ...p, approved: p.approval.approved, pending: p.approval.pending, queues: queues.filter((q) => q.slaPolicyId === p.id).map((q) => q.name) }))}
        canManage={hasPermission(session, Permission.SLA_MANAGE)}
      />
      <p className="mono-sm" style={{ margin: '10px 0 0' }}>
        Live tracking covers the pickup clock (first human response). Resolution targets are stored with the policy; conversations do not carry a resolution due time yet, so
        they are not tracked as breaches.
      </p>

      {inbox ? (
        <>
          <SecHead title="Waiting now" count={rows.length} desc="most urgent first · clocks tick live" style={{ marginTop: 22 }} />
          <WaitingList rows={rows} fractions={fractions} serverNow={now} label="Conversations waiting for a human" emptyText="No conversation is waiting for a human. Breaches and at-risk clocks appear here as soon as one is." />
        </>
      ) : null}
    </>
  );
}
