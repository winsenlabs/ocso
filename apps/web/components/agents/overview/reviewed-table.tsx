import Link from 'next/link';
import type { ControlState as DomainControlState } from '@ocso/domain';
import { ControlState, controlStateKind } from '@/components/ui/control-state';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { formatNumber } from '@/lib/format';
import type { ReviewedConversation } from '../data/analytics-schemas';

const CONTROL_STATES = new Set(['AI_ACTIVE', 'ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN', 'HUMAN_ACTIVE', 'AI_RESUMING', 'RESOLVED']);

/** "Latest reviewed conversations" (design/02 .dt-rev): rubric reviews in the analytics window. */
export function ReviewedTable({ items }: { items: ReviewedConversation[] }) {
  return (
    <DataTable
      label="Latest reviewed conversations"
      rows={items}
      rowKey={(r) => r.reviewId}
      template="minmax(0,1.6fr) 110px 110px 110px 60px"
      empty={<EmptyState size="sm" title="No reviews in this window">Rubric reviews of this agent&apos;s conversations appear here.</EmptyState>}
      columns={[
        {
          key: 'conv',
          header: 'Conversation',
          cell: (r) => (
            <Link className="cell-link" href={`/conversations/${r.conversationId}`}>
              <b style={{ fontSize: 12.5 }}>
                {r.customerName ?? 'Unknown customer'}
                {r.topic ? ` · ${r.topic}` : ''}
              </b>
              <span className="mono-sm" style={{ display: 'block' }}>
                {r.displayId}
                {r.channelKind ? ` · ${r.channelKind.toLowerCase()}` : ''}
              </span>
            </Link>
          ),
        },
        { key: 'reviewer', header: 'Reviewer', cell: (r) => <span className="mono-sm">{r.reviewerName}</span> },
        { key: 'outcome', header: 'Outcome', cell: (r) => <StatusChip tone={r.score >= 4 ? 'good' : r.score < 3 ? 'danger' : 'warn'}>{r.outcomeTag}</StatusChip> },
        {
          key: 'control',
          header: 'Control',
          cell: (r) => (CONTROL_STATES.has(r.controlState) ? <ControlState state={controlStateKind(r.controlState as DomainControlState)} /> : <span className="mono-sm">{r.controlState}</span>),
        },
        {
          key: 'score',
          header: 'Score',
          cell: (r) => (
            <span className="mono" title={Object.entries(r.rubric).map(([k, v]) => `${k} ${v}`).join(' · ')}>
              {formatNumber(r.score, 1)}
            </span>
          ),
        },
      ]}
    />
  );
}
