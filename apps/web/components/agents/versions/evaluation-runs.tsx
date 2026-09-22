import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricMatrix } from '@/components/ui/metric-matrix';
import { ChartCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { formatDateTime } from '@/lib/format';
import type { EvaluationResult, EvaluationRun } from '../data/quality-schemas';
import { evaluationTone } from '../lib/labels';
import { agentHref } from '../lib/tabs';
import { Definitions } from '../shared/definition';
import { RunPoller } from './run-poller';

const SUMMARY_KEYS = [
  ['cases', 'cases'],
  ['unchanged', 'unchanged'],
  ['changed', 'changed answer'],
  ['handoff_differs', 'handoff differs'],
  ['tool_call_differs', 'tool call differs'],
  ['errors', 'errors'],
] as const;

interface Props {
  agentId: string;
  runs: EvaluationRun[];
  selected: EvaluationRun | null;
  results: EvaluationResult[] | null;
  changedOnly: boolean;
  timeZone: string;
}

/** Replay evaluations of the draft against historical turns (design/02 "v13 → v14 evaluation"); no side effects. */
export function EvaluationRuns({ agentId, runs, selected, results, changedOnly, timeZone }: Props) {
  const active = runs.some((r) => r.status === 'QUEUED' || r.status === 'RUNNING');
  return (
    <section aria-label="Replay evaluations" style={{ marginTop: 18 }}>
      <SecHead title="Replay evaluations" count={runs.length || undefined} desc="the draft answers recent customer turns again · tools are never executed" actions={<RunPoller active={active} />} />
      {runs.length === 0 ? (
        <EmptyState size="sm" title="No replay evaluations yet">
          From the Prompt tab, save a draft and run it against recent customer turns before activating it.
        </EmptyState>
      ) : (
        <DataTable
          label="Replay evaluation runs"
          rows={runs}
          rowKey={(r) => r.id}
          selectedKey={selected?.id ?? null}
          template="minmax(0,1.2fr) 96px 90px 90px minmax(0,1fr)"
          columns={[
            {
              key: 'run',
              header: 'Run',
              cell: (r) => (
                <Link className="cell-link" href={agentHref(agentId, { tab: 'versions', run: r.id })}>
                  <b style={{ fontSize: 12.5 }}>{formatDateTime(r.createdAt, timeZone)}</b>
                  <span className="mono-sm" style={{ display: 'block' }}>
                    by {r.createdByName ?? 'system'} · draft vs {r.baselineVersion ? `v${r.baselineVersion}` : 'no baseline'}
                  </span>
                </Link>
              ),
            },
            { key: 'status', header: 'Status', cell: (r) => <StatusChip tone={evaluationTone(r.status)}>{r.status.toLowerCase()}</StatusChip> },
            { key: 'cases', header: 'Cases', cell: (r) => <span className="mono">{r.summary?.['cases'] ?? '—'} / {r.caseCount}</span> },
            { key: 'changed', header: 'Changed', cell: (r) => <span className="mono">{r.summary?.['changed'] ?? '—'}</span> },
            { key: 'flags', header: 'Flags', cell: (r) => <span className="mono-sm">{flagSummary(r)}</span> },
          ]}
        />
      )}
      {selected ? <RunDetail agentId={agentId} run={selected} results={results} changedOnly={changedOnly} /> : null}
    </section>
  );
}

function flagSummary(r: EvaluationRun): string {
  if (!r.summary) return r.status === 'FAILED' ? 'failed' : 'pending';
  const parts = [`${r.summary['errors'] ?? 0} errors`, `${r.summary['handoff_requested'] ?? 0} handoffs`];
  if (r.summary['skipped']) parts.push(`${r.summary['skipped']} skipped`);
  return parts.join(' · ');
}

function RunDetail({ agentId, run, results, changedOnly }: { agentId: string; run: EvaluationRun; results: EvaluationResult[] | null; changedOnly: boolean }) {
  return (
    <ChartCard title={`Draft vs ${run.baselineVersion ? `v${run.baselineVersion}` : 'no baseline'} · replay`} meta={<span className="mono-sm">{run.caseCount} cases requested</span>}>
      {run.summary ? (
        <MetricMatrix columns={6} metrics={SUMMARY_KEYS.map(([k, label]) => ({ label, value: run.summary?.[k] ?? 0 }))} />
      ) : (
        <span className="mono-sm">{run.status === 'FAILED' ? 'The run failed before producing results.' : 'Waiting for the worker to replay the cases…'}</span>
      )}
      <div className="rowsplit">
        <Link className={changedOnly ? 'btn tiny' : 'btn tiny accent'} href={agentHref(agentId, { tab: 'versions', run: run.id })} aria-pressed={!changedOnly}>
          All cases
        </Link>
        <Link className={changedOnly ? 'btn tiny accent' : 'btn tiny'} href={agentHref(agentId, { tab: 'versions', run: run.id, changed: '1' })} aria-pressed={changedOnly}>
          Changed only
        </Link>
      </div>
      {results === null ? (
        <span className="mono-sm">Per-case results are not available for your role.</span>
      ) : results.length === 0 ? (
        <EmptyState size="sm" title={changedOnly ? 'No changed answers' : 'No cases yet'}>
          {changedOnly ? 'The draft answered every replayed turn like the live version.' : 'Results appear here as the worker replays each turn.'}
        </EmptyState>
      ) : (
        <DataTable
          label="Replay cases"
          rows={results}
          rowKey={(r) => r.id}
          template="minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr) 120px"
          columns={[
            { key: 'customer', header: 'Customer turn', cell: (r) => <span className="reply customer">{r.customerText}</span> },
            { key: 'baseline', header: 'Live version', cell: (r) => <span className="reply">{r.baselineText ?? '—'}</span> },
            { key: 'candidate', header: 'Draft', cell: (r) => <span className="reply">{r.candidateText ?? '—'}</span> },
            {
              key: 'flags',
              header: 'Result',
              cell: (r) => (
                <span style={{ display: 'grid', gap: 3 }}>
                  <StatusChip tone={r.changed ? 'warn' : 'good'}>{r.changed ? 'changed' : 'same'}</StatusChip>
                  {r.flags?.length ? <span className="mono-sm">{r.flags.join(' · ').replace(/_/g, ' ')}</span> : null}
                </span>
              ),
            },
          ]}
        />
      )}
      <Definitions summary="How a case is judged" items={[{ label: 'changed', definition: run.summaryDefinition }]} />
    </ChartCard>
  );
}
