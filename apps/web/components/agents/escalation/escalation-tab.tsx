import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listEscalationRules } from '@/lib/api/agents';
import type { EscalationRule } from '../data/agent-schemas';
import { optionName } from '../data/options';
import type { AgentPageData } from '../detail/load';
import { MODE_LABELS, TRIGGER_LABELS, priorityTone } from '../lib/labels';
import { describeCondition } from '../lib/rules';
import { AddRuleButton, RuleActions } from './rule-actions';

/**
 * Escalation tab (design/02): deterministic handoff rules for this agent,
 * plus platform-wide rules that also apply. The "fired 7d" column of the
 * mockup is omitted: handoffs are not attributed to rules by the API.
 */
export async function EscalationTab({ data }: { data: AgentPageData }) {
  const { agent, options, can } = data;
  const rules = await listEscalationRules(agent.id);
  const active = rules.filter((r) => r.enabled).length;
  const defaultQueue = optionName(options.queues, agent.defaultQueueId);
  const target = (r: EscalationRule) =>
    r.targetQueueId ? (optionName(options.queues, r.targetQueueId) ?? 'another queue') : defaultQueue ? `${defaultQueue} (default)` : 'agent default queue';

  return (
    <>
      <SecHead
        title="Escalation rules"
        count={`${active} active`}
        desc="evaluated in code on every turn · new rules start as drafts; turning one on needs a checker's approval"
        actions={can.escalation ? <AddRuleButton agentId={agent.id} queues={options.queues} /> : null}
      />
      <DataTable
        label="Escalation rules"
        rows={rules}
        rowKey={(r) => r.id}
        template={can.escalation ? 'minmax(0,1.5fr) 96px minmax(0,1fr) 64px 100px 60px minmax(220px,1.2fr)' : 'minmax(0,1.6fr) 96px minmax(0,1fr) 64px 110px 60px'}
        empty={
          <EmptyState title="No escalation rules">
            {can.escalation
              ? 'Add a rule for handoffs that must always happen — a refund above an amount, hardship language, repeated tool failures.'
              : 'A Lead adds rules for handoffs that must always happen.'}
          </EmptyState>
        }
        columns={[
          {
            key: 'trigger',
            header: 'Trigger',
            cell: (r) => (
              <>
                <b style={{ fontSize: 12.5, fontWeight: 500 }}>{r.name}</b>
                <span className="mono-sm" style={{ display: 'block' }}>
                  {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                  {describeCondition(r.condition) ? ` · ${describeCondition(r.condition)}` : ''}
                </span>
              </>
            ),
          },
          { key: 'mode', header: 'Mode', cell: (r) => <span className="mono-sm">{MODE_LABELS[r.mode] ?? r.mode}</span> },
          { key: 'target', header: 'Target', cell: (r) => <span className="mono-sm">{target(r)}</span> },
          { key: 'priority', header: 'Priority', cell: (r) => <StatusChip tone={priorityTone(r.priority)}>{r.priority}</StatusChip> },
          { key: 'scope', header: 'Scope', cell: (r) => <span className="mono-sm">{r.agentId ? 'this agent' : 'platform-wide'}</span> },
          { key: 'state', header: 'State', cell: (r) => <StatusChip tone={r.enabled ? 'good' : 'muted'}>{r.enabled ? 'on' : r.approval.approved ? 'off' : 'draft'}</StatusChip> },
          ...(can.escalation
            ? [
                {
                  key: 'actions',
                  header: '',
                  cell: (r: EscalationRule) =>
                    r.agentId ? <RuleActions agentId={agent.id} rule={r} queues={options.queues} /> : <span className="mono-sm">applies to every agent</span>,
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
