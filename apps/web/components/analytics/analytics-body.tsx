import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { loadAgentComparison, loadOverview, loadQueueAnalytics, type AgentComparison, type Overview, type QueueAnalytics } from '@/lib/api/analytics';
import { hasPermission, requireSession } from '@/lib/session';
import { AgentComparisonTable, EscalationRanking } from './agent-comparison';
import { numberNotes, parseDays, windowLabel } from './metrics';
import { OverviewCards, OverviewCharts, OverviewTiles } from './overview';
import { param, type SearchParams } from './params';
import { Definitions, WindowBar } from './parts';
import { QueueAnalyticsTable } from './queue-analytics-table';

/** Footnote order: tiles, then panels, then the comparison and queue columns (shared formulas share a number). */
function notesFor(o: Overview, c: AgentComparison, q: QueueAnalytics) {
  const t = o.tiles;
  return numberNotes([
    ['conversations', t.conversations.definition],
    ['containmentRate', t.containmentRate.definition],
    ['escalationRate', t.escalationRate.definition],
    ['resolutionRate', t.resolutionRate.definition],
    ['firstResponseAiMedianSeconds', t.firstResponseAiMedianSeconds.definition],
    ['slaBreaches', t.slaBreaches.definition],
    ['toolFailureRate', t.toolFailureRate.definition],
    ['csat', t.csat.definition],
    ['escalationReasons', o.escalationReasons.definition],
    ['channels', o.channels.definition],
    ['handlingTime', o.handlingTime.definition],
    ['timeToResolution', o.timeToResolution.definition],
    ['reopenRate', o.reopenRate.definition],
    ['costPerConversation', o.costPerConversation.definition],
    ['failureTopics', o.failureTopics.definition],
    ...(o.tags.definition ? ([['tags', o.tags.definition]] as const) : []),
    ['knowledgeGaps', o.knowledgeGaps.definition],
    ...Object.entries(c.definitions).map(([k, d]) => [`agents.${k}`, d] as const),
    ...Object.entries(q.definitions).map(([k, d]) => [`queues.${k}`, d] as const),
  ]);
}

/** Lead analytics (docs/11 §3): overview, agent-by-agent comparison and queue performance. */
export async function AnalyticsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.ANALYTICS_BUSINESS_READ)) return <NotPermitted role={session.roleLabel} />;
  const days = parseDays(param(params, 'days'));
  const [overview, comparison, queues] = await Promise.all([loadOverview(days), loadAgentComparison(days), loadQueueAnalytics(days)]);
  const notes = notesFor(overview, comparison, queues);
  const noConversations = overview.tiles.conversations.value === 0;

  return (
    <>
      <WindowBar basePath="/analytics" days={days} window={overview.window} />
      {comparison.agents.length === 0 ? (
        <EmptyState
          title="No virtual agents yet"
          actions={
            hasPermission(session, Permission.AGENTS_MANAGE) ? (
              <Link className="btn tiny" href="/agents">
                Virtual agents
              </Link>
            ) : null
          }
        >
          Analytics are computed from conversations handled by virtual agents. Create an agent and connect a channel; metrics appear as conversations open.
        </EmptyState>
      ) : noConversations ? (
        <AlertBanner title={`No conversations opened in the ${windowLabel(days)}`}>
          Metrics that need conversations show “no data in window” rather than a zero. Pick a longer window, or check that channels are connected.
        </AlertBanner>
      ) : null}

      <OverviewTiles overview={overview} refs={notes.refs} />
      <OverviewCharts overview={overview} days={days} refs={notes.refs} />
      <OverviewCards overview={overview} refs={notes.refs} aside={<EscalationRanking comparison={comparison} days={days} />} />

      <SecHead title="Agent comparison" count={`${comparison.agents.length} agent${comparison.agents.length === 1 ? '' : 's'}`} desc="same formulas as the tiles, per virtual agent" style={{ marginTop: 18 }} />
      <AgentComparisonTable comparison={comparison} refs={notes.refs} />

      <SecHead title="Queues" count={queues.queues.length} desc="workload now, and pickup performance for conversations opened in the window" style={{ marginTop: 22 }} />
      <QueueAnalyticsTable data={queues} refs={notes.refs} />

      <Definitions notes={notes.list} />
    </>
  );
}
