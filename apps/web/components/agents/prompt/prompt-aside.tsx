import Link from 'next/link';
import { ChartCard } from '@/components/ui/rail-card';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { VersionRow } from '@/components/ui/version-row';
import type { PromptPreview, PromptVersion } from '../data/agent-schemas';
import type { Correction, EvaluationRun } from '../data/quality-schemas';
import { componentLabel, correctionTone, evaluationTone, formatDay, shortHash } from '../lib/labels';
import { agentHref } from '../lib/tabs';

export function LiveVersionCard({ live, timeZone }: { live: PromptVersion | null; timeZone: string }) {
  return (
    <ChartCard title="Live version" meta={live ? <StatusChip tone="good">v{live.version}</StatusChip> : <StatusChip tone="warn">none</StatusChip>}>
      {live ? (
        <KeyValue
          template="minmax(80px,96px) minmax(0,1fr)"
          items={[
            { k: 'author', v: live.authorName ?? 'system' },
            { k: 'activated', v: live.firstActivatedAt ? `${formatDay(live.firstActivatedAt, timeZone)} (first)` : '—' },
            { k: 'hash', v: <span className="mono-sm" title={live.promptHash}>{shortHash(live.promptHash)}</span> },
            { k: 'contract', v: <span className="mono-sm">{live.runtimeContractVersion}</span> },
            { k: 'reason', v: live.reason },
          ]}
        />
      ) : (
        <span className="mono-sm">No version is active. Activate one from Versions before going live.</span>
      )}
    </ChartCard>
  );
}

/** Compiled draft: provider-agnostic token estimate and the cache prefix hash (docs/archive/specs/05 §3). */
export function CompiledCard({ preview, live }: { preview: PromptPreview | null; live: PromptVersion | null }) {
  if (!preview) return null;
  const same = live ? live.promptHash === preview.hashes.promptVersionHash : null;
  return (
    <ChartCard title="Compiled draft" meta={same === null ? null : same ? <StatusChip tone="muted">same as live</StatusChip> : <StatusChip tone="accent">differs from live</StatusChip>}>
      <div className="hashes" aria-label="Compiled prompt hashes">
        <span className="k">tokens</span>
        <span>
          <b data-testid="compiled-tokens">{preview.tokenEstimate.total.toLocaleString('en')}</b>{' '}
          <span className="mono-sm">
            stable {preview.tokenEstimate.stable.toLocaleString('en')} · conversation {preview.tokenEstimate.conversation.toLocaleString('en')} · estimate
          </span>
        </span>
        <span className="k">prefix hash</span>
        <span className="mono-sm" data-testid="prefix-hash" title="Hash of everything before the agent-prefix cache breakpoint (tools + stable system blocks)">
          {preview.hashes.agentPrefixHash}
        </span>
        <span className="k">prompt hash</span>
        <span className="mono-sm" data-testid="prompt-hash">
          {preview.hashes.promptVersionHash}
        </span>
        <span className="k">contract</span>
        <span className="mono-sm">{preview.hashes.runtimeContractVersion}</span>
      </div>
      <div className="foot">
        <span className="mono-sm">preview excludes tool schemas and uses a sample customer turn</span>
      </div>
    </ChartCard>
  );
}

export function HistoryCard({ agentId, versions, liveId, timeZone }: { agentId: string; versions: PromptVersion[]; liveId: string | null; timeZone: string }) {
  return (
    <div className="ch vlist">
      <div className="vhead">
        <div className="t">
          <h3>Version history</h3>
          <Link className="mono-sm" style={{ marginLeft: 'auto' }} href={agentHref(agentId, { tab: 'versions' })}>
            all →
          </Link>
        </div>
      </div>
      {versions.slice(0, 4).map((v) => (
        <VersionRow key={v.id} version={`v${v.version}`} title={v.reason} who={v.authorName ?? 'system'} when={formatDay(v.createdAt, timeZone)} live={v.id === liveId} />
      ))}
    </div>
  );
}

export function CorrectionCard({ agentId, corrections, labels }: { agentId: string; corrections: Correction[]; labels: ReadonlyMap<string, string> }) {
  const staged = corrections.filter((c) => c.status === 'STAGED');
  const open = corrections.filter((c) => c.status === 'OPEN');
  const top = staged[0] ?? open[0];
  return (
    <ChartCard title="Corrections from conversations" meta={<StatusChip tone={staged.length ? 'accent' : 'muted'}>{staged.length} staged</StatusChip>}>
      {top ? (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>{top.title}</div>
          <KeyValue
            template="minmax(80px,90px) minmax(0,1fr)"
            items={[
              { k: 'observed', v: top.observed },
              { k: 'desired', v: top.desired },
              { k: 'component', v: componentLabel(top.componentKey, labels) },
              { k: 'status', v: <StatusChip tone={correctionTone(top.status)}>{top.status === 'STAGED' ? 'staged in draft' : `${top.status.toLowerCase()} · seen ${top.occurrences}×`}</StatusChip> },
            ]}
          />
          <div className="rowsplit">
            {top.conversationId ? (
              <Link className="btn tiny" href={`/conversations/${top.conversationId}`}>
                Open source conversation
              </Link>
            ) : null}
            <Link className="btn tiny ghost" href={agentHref(agentId, { tab: 'quality' })}>
              All corrections ({open.length} open)
            </Link>
          </div>
        </>
      ) : (
        <span className="mono-sm">No open corrections. Record one from a conversation turn or the Quality tab.</span>
      )}
    </ChartCard>
  );
}

export function EvaluationCard({ agentId, run }: { agentId: string; run: EvaluationRun | null }) {
  return (
    <ChartCard title="Latest replay evaluation" meta={run ? <StatusChip tone={evaluationTone(run.status)}>{run.status.toLowerCase()}</StatusChip> : null}>
      {run ? (
        <>
          <span className="mono-sm">
            {run.caseCount} cases vs {run.baselineVersion ? `v${run.baselineVersion}` : 'no baseline'}
            {run.summary ? ` · ${run.summary['changed'] ?? 0} changed · ${run.summary['errors'] ?? 0} errors` : ''}
          </span>
          <Link className="btn tiny" href={agentHref(agentId, { tab: 'versions', run: run.id })}>
            Open results
          </Link>
        </>
      ) : (
        <span className="mono-sm">No replay yet. Save a draft, then run it against recent customer turns before activating.</span>
      )}
    </ChartCard>
  );
}
