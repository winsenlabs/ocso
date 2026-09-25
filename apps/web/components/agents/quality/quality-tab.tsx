import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { getRubric, listCorrections, listReviews, optional } from '@/lib/api/agents';
import { formatNumber } from '@/lib/format';
import type { Correction, Review, Rubric } from '../data/quality-schemas';
import type { AgentPageData } from '../detail/load';
import { correctionTone, formatDay, humanizeCode } from '../lib/labels';
import { Def, Definitions } from '../shared/definition';
import { CorrectionActions, NewCorrectionButton } from './correction-dialogs';

/**
 * Quality tab: the prompt correction workflow for this agent (docs/archive/specs/09 §7:
 * source turn → observed/desired → staged into the draft → applied by a
 * version) and the rubric reviews of its conversations (docs/archive/specs/11 §3).
 */
export async function QualityTab({ data }: { data: AgentPageData }) {
  const { agent, prompt, can, timeZone } = data;
  const [corrections, reviews, rubric] = await Promise.all([
    can.corrections ? optional(listCorrections(agent.id)) : Promise.resolve(null),
    can.reviews ? optional(listReviews(agent.id)) : Promise.resolve(null),
    can.reviews ? optional(getRubric()) : Promise.resolve(null),
  ]);
  const labels: Record<string, string> = Object.fromEntries(prompt.components.map((c) => [c.key, c.label]));
  const versionOf = new Map(prompt.versions.map((v) => [v.id, v.version]));

  return (
    <>
      {corrections ? (
        <section aria-label="Prompt corrections" style={{ marginBottom: 20 }}>
          <SecHead
            title="Prompt corrections"
            count={`${corrections.filter((c) => c.status === 'OPEN').length} open · ${corrections.filter((c) => c.status === 'STAGED').length} staged`}
            desc="staged into the draft, applied when a version includes them · nothing changes the live prompt invisibly"
            actions={<NewCorrectionButton agentId={agent.id} labels={labels} />}
          />
          <DataTable
            label="Prompt corrections"
            rows={corrections}
            rowKey={(c) => c.id}
            template="minmax(0,2fr) minmax(0,0.8fr) 60px 110px 150px"
            empty={<EmptyState title="No corrections for this agent">Flag a turn in a conversation (or record one here) when the agent should behave differently.</EmptyState>}
            columns={[
              { key: 'what', header: 'Correction', cell: (c) => <CorrectionCell c={c} timeZone={timeZone} /> },
              { key: 'component', header: 'Component', cell: (c) => <span className="mono-sm">{labels[c.componentKey] ?? humanizeCode(c.componentKey)}</span> },
              { key: 'seen', header: 'Seen', cell: (c) => <span className="mono">{c.occurrences}×</span> },
              {
                key: 'status',
                header: 'Status',
                cell: (c) => (
                  <StatusChip tone={correctionTone(c.status)}>
                    {c.status === 'APPLIED' && c.resultingVersionId && versionOf.has(c.resultingVersionId) ? `applied · v${versionOf.get(c.resultingVersionId)}` : c.status.toLowerCase()}
                  </StatusChip>
                ),
              },
              { key: 'actions', header: '', cell: (c) => <CorrectionActions correction={c} labels={labels} /> },
            ]}
          />
        </section>
      ) : null}
      {reviews ? <Reviews reviews={reviews} rubric={rubric} timeZone={timeZone} /> : null}
      {!corrections && !reviews ? <EmptyState title="Quality data is not available for your role">Leads review conversations and manage prompt corrections.</EmptyState> : null}
    </>
  );
}

function CorrectionCell({ c, timeZone }: { c: Correction; timeZone: string }) {
  return (
    <>
      <b style={{ fontSize: 12.5, fontWeight: 500 }}>{c.title}</b>
      <span className="mono-sm row-note">
        observed: {c.observed} → desired: {c.desired}
      </span>
      <span className="mono-sm row-note">
        {c.source === 'INTERNAL_AGENT' ? 'via Ask OCSO' : c.source === 'INSIGHTS' ? 'from insights' : 'by a lead'} · {formatDay(c.createdAt, timeZone)}
        {c.conversationId ? (
          <>
            {' · '}
            <Link href={`/conversations/${c.conversationId}`}>source conversation{c.interactionSeq ? ` · turn ${c.interactionSeq}` : ''}</Link>
          </>
        ) : null}
      </span>
    </>
  );
}

function Reviews({ reviews, rubric, timeZone }: { reviews: Review[]; rubric: Rubric | null; timeZone: string }) {
  const criteria = rubric ? Object.entries(rubric.criteria) : [];
  return (
    <section aria-label="Reviewed conversations">
      <SecHead title="Reviewed conversations" count={reviews.length} desc="rubric-scored by Leads · no opaque quality score" />
      <DataTable
        label="Reviewed conversations"
        rows={reviews}
        rowKey={(r) => r.id}
        template="minmax(0,1.6fr) 110px minmax(0,1fr) 110px 70px"
        empty={<EmptyState title="No reviews yet">Reviews of this agent&apos;s conversations appear here with their rubric scores.</EmptyState>}
        columns={[
          {
            key: 'conv',
            header: 'Conversation',
            cell: (r) => (
              <Link className="cell-link" href={`/conversations/${r.conversationId}`}>
                <b style={{ fontSize: 12.5 }}>{r.customerName ?? 'Unknown customer'}</b>
                <span className="mono-sm row-note">
                  {r.displayId} · {formatDay(r.createdAt, timeZone)}
                </span>
              </Link>
            ),
          },
          { key: 'reviewer', header: 'Reviewer', cell: (r) => <span className="mono-sm">{r.reviewer.name}</span> },
          { key: 'outcome', header: 'Outcome', cell: (r) => <StatusChip tone={r.score >= 4 ? 'good' : r.score < 3 ? 'danger' : 'warn'}>{r.outcomeTag}</StatusChip> },
          { key: 'state', header: 'Control', cell: (r) => <span className="mono-sm">{humanizeCode(r.controlState).toLowerCase()}</span> },
          {
            key: 'score',
            header: <Def definition={rubric?.scoreDefinition}>Score</Def>,
            cell: (r) => (
              <span className="mono" title={Object.entries(r.rubric).map(([k, v]) => `${k} ${v}`).join(' · ')}>
                {formatNumber(r.score, 1)}
              </span>
            ),
          },
        ]}
      />
      {rubric ? (
        <Definitions
          summary="Rubric"
          items={[{ label: 'score', definition: rubric.scoreDefinition }, ...criteria.map(([k, v]) => ({ label: `${k} (${rubric.scale.min}–${rubric.scale.max})`, definition: v }))]}
        />
      ) : null}
    </section>
  );
}
