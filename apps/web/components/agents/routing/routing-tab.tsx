import { EmptyState } from '@/components/ui/empty-state';
import { KeyValue } from '@/components/ui/key-value';
import { ChartCard } from '@/components/ui/rail-card';
import { StatusChip } from '@/components/ui/status-chip';
import { listSlaPolicies, optional } from '@/lib/api/agents';
import { formatDuration } from '@/lib/format';
import type { Queue, SlaPolicy } from '../data/agent-schemas';
import type { AgentPageData } from '../detail/load';
import { MODE_LABELS, humanizeCode } from '../lib/labels';
import { QueuePicker } from './queue-picker';

/**
 * Routing tab (design/02): the agent's default handoff queue and its SLA
 * targets. The mockup's SLA attainment bars are omitted: attainment per
 * queue is not exposed by the API; breaches waiting now are shown instead.
 */
export async function RoutingTab({ data }: { data: AgentPageData }) {
  const { agent, options, can } = data;
  const queues = options.queueRows;
  if (!queues) return <EmptyState title="Queues are not available for your role">A Lead manages queues and SLA policies.</EmptyState>;
  const queue = queues.find((q) => q.id === agent.defaultQueueId) ?? null;
  const policies = await optional(listSlaPolicies());
  const sla = queue?.slaPolicyId ? (policies?.find((p) => p.id === queue.slaPolicyId) ?? null) : null;

  return (
    <>
      {can.manage && options.queues ? <QueuePicker key={agent.defaultQueueId ?? 'none'} agentId={agent.id} queues={options.queues} current={agent.defaultQueueId} /> : null}
      {queue ? (
        <div className="g g2">
          <QueueCard queue={queue} />
          <SlaCard queue={queue} sla={sla} />
        </div>
      ) : (
        <EmptyState title="No default queue">
          Handoffs from this agent go to the queue an escalation rule names. Set a default queue so every handoff has somewhere to land.
        </EmptyState>
      )}
    </>
  );
}

function QueueCard({ queue: q }: { queue: Queue }) {
  const assignment =
    q.mode === 'AUTO_ASSIGN'
      ? `Auto-assign · accept within ${formatDuration(q.acceptTimeoutSeconds)}`
      : `Open pickup${q.autoAssignAfterSeconds ? `, then auto-assign after ${formatDuration(q.autoAssignAfterSeconds)}` : ''}`;
  return (
    <ChartCard title="Queue and assignment" meta={<StatusChip tone={q.waiting ? 'warn' : 'muted'}>{q.waiting} waiting</StatusChip>}>
      <KeyValue
        items={[
          { k: 'default queue', v: `${q.name} · ${q.members} people · ${q.onShift} on shift` },
          { k: 'handoff mode', v: assignment },
          { k: 'strategy', v: q.strategy === 'LEAST_ACTIVE' ? 'Least active workload' : humanizeCode(q.strategy) },
          { k: 'skills', v: q.requiredSkills.length ? q.requiredSkills.join(' · ') : 'none required' },
          { k: 'languages', v: q.languages.length ? q.languages.join(', ') : 'any' },
          { k: 'account owner', v: q.preferAccountOwner ? 'Preferred when on shift' : 'Not preferred' },
          { k: 'after hours', v: q.afterHoursMessage ?? 'No after-hours message' },
        ]}
      />
      <div className="foot">
        <span className="mono-sm">mode {MODE_LABELS[q.mode] ?? q.mode} · {q.breaches} waiting past SLA now</span>
      </div>
    </ChartCard>
  );
}

function SlaCard({ queue, sla }: { queue: Queue; sla: SlaPolicy | null }) {
  if (!sla) {
    return (
      <ChartCard title="SLA policy">
        <span className="mono-sm">{queue.slaPolicyId ? 'The SLA policy is not readable for your role.' : `${queue.name} has no SLA policy.`}</span>
      </ChartCard>
    );
  }
  const pickups = Object.entries(sla.pickupSecondsByPriority).sort(([a], [b]) => a.localeCompare(b));
  const resolutions = Object.entries(sla.resolutionSecondsByType);
  return (
    <ChartCard title="SLA policy" meta={<span className="mono-sm">{sla.name}</span>}>
      <KeyValue
        items={[
          { k: 'first human response', v: formatDuration(sla.firstHumanResponseSeconds) },
          ...pickups.map(([p, s]) => ({ k: `${p} pickup`, v: formatDuration(s) })),
          ...resolutions.map(([type, s]) => ({ k: `resolution · ${type.toLowerCase()}`, v: formatDuration(s) })),
          { k: 'at risk from', v: `${Math.round(sla.atRiskFraction * 100)}% of the target elapsed` },
        ]}
      />
      <div className="foot">
        <span className="mono-sm">targets · breaches are counted in analytics</span>
      </div>
    </ChartCard>
  );
}
