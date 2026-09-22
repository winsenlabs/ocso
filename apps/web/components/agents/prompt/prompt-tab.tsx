import Link from 'next/link';
import { SecHead } from '@/components/ui/sec-head';
import { getPromptPreview, listCorrections, listEvaluationRuns, optional } from '@/lib/api/agents';
import type { PromptPreview } from '../data/agent-schemas';
import type { AgentPageData } from '../detail/load';
import { componentLabel } from '../lib/labels';
import { agentHref } from '../lib/tabs';
import { CompiledCard, CorrectionCard, EvaluationCard, HistoryCard, LiveVersionCard } from './prompt-aside';
import { PromptEditor } from './prompt-editor';

/** Prompt tab (design/02): component editor, compiled preview and the version/correction rail. */
export async function PromptTab({ data }: { data: AgentPageData }) {
  const { agent, prompt, live, can, timeZone } = data;
  const [preview, corrections, runs] = await Promise.all([
    optional(getPromptPreview(agent.id)),
    can.corrections ? optional(listCorrections(agent.id)) : Promise.resolve(null),
    can.evaluations ? optional(listEvaluationRuns(agent.id)) : Promise.resolve(null),
  ]);
  const labels = new Map(prompt.components.map((c) => [c.key, c.label]));
  const parent = live?.parentVersionId ? prompt.versions.find((v) => v.id === live.parentVersionId) : undefined;
  const nextVersion = (prompt.versions[0]?.version ?? 0) + 1;
  const staged = (corrections ?? []).filter((c) => c.status === 'STAGED').map((c) => ({ id: c.id, title: c.title, componentLabel: componentLabel(c.componentKey, labels) }));

  return (
    <div className="prompt-grid">
      <div style={{ minWidth: 0 }}>
        <SecHead
          title="Prompt components"
          desc="compiled in order · stable content first so the provider cache keeps the prefix"
          actions={
            <>
              {live && parent ? (
                <Link className="btn tiny ghost" href={agentHref(agent.id, { tab: 'versions', from: parent.id, to: live.id })}>
                  Diff v{parent.version} → v{live.version}
                </Link>
              ) : null}
              {preview ? (
                <a className="btn tiny" href="#compiled-preview">
                  Preview compiled
                </a>
              ) : null}
            </>
          }
        />
        <PromptEditor
          agentId={agent.id}
          components={prompt.components}
          live={live?.components ?? null}
          liveVersionId={live?.id ?? null}
          nextVersion={nextVersion}
          compiledTokens={preview?.tokenEstimate.total ?? null}
          hashChanges={preview && live ? preview.hashes.promptVersionHash !== live.promptHash : null}
          corrections={staged}
          can={{ edit: can.editPrompt, activate: can.activate, evaluate: can.evaluations }}
        />
        {preview ? <CompiledPreview preview={preview} /> : null}
      </div>
      <aside aria-label="Prompt versions and corrections">
        <LiveVersionCard live={live} timeZone={timeZone} />
        <CompiledCard preview={preview} live={live} />
        <HistoryCard agentId={agent.id} versions={prompt.versions} liveId={live?.id ?? null} timeZone={timeZone} />
        {corrections ? <CorrectionCard agentId={agent.id} corrections={corrections} labels={labels} /> : null}
        {runs ? <EvaluationCard agentId={agent.id} run={runs[0] ?? null} /> : null}
      </aside>
    </div>
  );
}

/** The compiled system prompt of the saved draft, block by block, with cache breakpoints marked. */
function CompiledPreview({ preview }: { preview: PromptPreview }) {
  return (
    <details className="compiled" id="compiled-preview">
      <summary>
        Compiled system prompt · {preview.system.length} blocks · ~{preview.tokenEstimate.total.toLocaleString('en')} tokens (sample customer turn)
      </summary>
      <pre>
        {preview.system.map((b) => (
          <span key={b.key}>
            {b.text}
            {'\n'}
            {b.breakpointAfter ? <span className="bp">cache breakpoint · {b.breakpointAfter.toLowerCase().replace(/_/g, ' ')}</span> : '\n'}
          </span>
        ))}
      </pre>
    </details>
  );
}
