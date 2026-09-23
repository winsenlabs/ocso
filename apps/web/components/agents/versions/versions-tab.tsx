import Link from 'next/link';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { getPromptDiff, listEvaluationResults, listEvaluationRuns, optional } from '@/lib/api/agents';
import { formatDateTime } from '@/lib/format';
import type { PromptVersion } from '../data/agent-schemas';
import type { AgentPageData } from '../detail/load';
import type { Query } from '../detail/agent-detail';
import { componentLabel, shortHash } from '../lib/labels';
import { agentHref, isUuid, param } from '../lib/tabs';
import { ActivateButton } from './activate-button';
import { DiffView } from './diff-view';
import { EvaluationRuns } from './evaluation-runs';

/** Versions tab (design/02): immutable history, diff, activation/rollback and replay evaluations. */
export async function VersionsTab({ data, query }: { data: AgentPageData; query: Query }) {
  const { agent, prompt, can, timeZone } = data;
  const labels = new Map(prompt.components.map((c) => [c.key, c.label]));
  const byId = new Map(prompt.versions.map((v) => [v.id, v]));
  const fromId = param(query, 'from');
  const toId = param(query, 'to');
  const from = isUuid(fromId) ? byId.get(fromId) : undefined;
  const to = isUuid(toId) ? byId.get(toId) : undefined;
  const runId = param(query, 'run');
  const changedOnly = param(query, 'changed') === '1';

  const [diff, runs] = await Promise.all([
    from && to ? optional(getPromptDiff(agent.id, from.id, to.id)) : Promise.resolve(null),
    can.evaluations ? optional(listEvaluationRuns(agent.id)) : Promise.resolve(null),
  ]);
  const selected = runs?.find((r) => r.id === runId) ?? null;
  const results = selected ? await optional(listEvaluationResults(selected.id, changedOnly)) : null;

  return (
    <>
      <SecHead
        title="Versions"
        count={prompt.versions.length}
        desc="every material change is immutable, attributable and reversible"
        actions={
          can.editPrompt ? (
            <Link className="btn tiny accent" href={agentHref(agent.id, { tab: 'prompt' })}>
              {prompt.dirty ? 'Create new version' : 'Edit prompt'}
            </Link>
          ) : null
        }
      />
      {prompt.versions.length === 0 ? (
        <EmptyState title="No versions yet">Versions appear here once the prompt has been saved as a version.</EmptyState>
      ) : (
        <div className="dtable" role="list" aria-label="Prompt versions">
          {prompt.versions.map((v) => (
            <VersionItem key={v.id} v={v} data={data} parent={v.parentVersionId ? byId.get(v.parentVersionId) : undefined} labels={labels} />
          ))}
        </div>
      )}

      {prompt.versions.length > 1 ? (
        <form className="compare" method="get" action={`/agents/${agent.id}`} aria-label="Compare versions">
          <input type="hidden" name="tab" value="versions" />
          <div className="fld">
            <label htmlFor="cmp-from">From</label>
            <select id="cmp-from" name="from" defaultValue={from?.id ?? prompt.versions[1]?.id}>
              {prompt.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="cmp-to">To</label>
            <select id="cmp-to" name="to" defaultValue={to?.id ?? prompt.versions[0]?.id}>
              {prompt.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">
            Compare
          </button>
        </form>
      ) : null}

      {from && to && diff ? <DiffView diff={diff} from={from} to={to} labels={labels} /> : null}
      {runs ? <EvaluationRuns agentId={agent.id} runs={runs} selected={selected} results={results} changedOnly={changedOnly} timeZone={timeZone} /> : null}
    </>
  );
}

function VersionItem({ v, data, parent, labels }: { v: PromptVersion; data: AgentPageData; parent: PromptVersion | undefined; labels: ReadonlyMap<string, string> }) {
  const { agent, live, can, timeZone } = data;
  const isLive = v.id === live?.id;
  const changed = v.changedComponents.map((k) => componentLabel(k, labels)).join(', ');
  const corrections = v.correctionIds?.length ?? 0;
  return (
    <div className={isLive ? 'vrow act live' : 'vrow act'} role="listitem" data-version={v.version}>
      <span className="vdot" role={isLive ? 'img' : undefined} aria-label={isLive ? 'live version' : undefined} />
      <span className="vid">v{v.version}</span>
      <span style={{ minWidth: 0 }}>
        <b style={{ fontWeight: 500 }}>{v.reason}</b>
        <span className="mono-sm" style={{ display: 'block' }}>
          {changed || 'no component changes'} · hash {shortHash(v.promptHash)}
          {corrections ? ` · ${corrections} correction${corrections === 1 ? '' : 's'}` : ''}
          {isLive ? ' · live' : ''}
        </span>
      </span>
      <span className="vwho">{v.authorName ?? 'system'}</span>
      <span className="mono-sm">{formatDateTime(v.createdAt, timeZone)}</span>
      <span className="vacts">
        {parent ? (
          <Link className="btn tiny ghost" href={agentHref(agent.id, { tab: 'versions', from: parent.id, to: v.id })} aria-label={`Diff v${parent.version} to v${v.version}`}>
            Diff
          </Link>
        ) : null}
        {can.activate && !isLive ? <ActivateButton agentId={agent.id} versionId={v.id} version={v.version} liveVersion={live?.version ?? null} /> : null}
      </span>
    </div>
  );
}
