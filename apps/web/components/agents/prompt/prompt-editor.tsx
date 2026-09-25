'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { discardDraftAction, saveDraftAction, startEvaluationAction } from '@/lib/actions/agents';
import type { PromptComponent } from '../data/agent-schemas';
import { componentLabel } from '../lib/labels';
import { componentState, draftChanges, draftTexts, effectiveEdits, estimateTokens, isComponentKey, mergeEdits, type Edits } from '../lib/prompt-draft';
import { agentHref } from '../lib/tabs';
import { ConfirmButton } from '../shared/confirm-button';
import { useAgentAction } from '../shared/use-action';
import { ComponentCard } from './component-card';
import { CreateVersionDialog, type StagedCorrection } from './create-version-dialog';

export const REPLAY_CASES = 40;

interface Props {
  agentId: string;
  components: PromptComponent[];
  /** Components of the live version (null: no active version). */
  live: Readonly<Record<string, string>> | null;
  liveVersionId: string | null;
  nextVersion: number;
  compiledTokens: number | null;
  hashChanges: boolean | null;
  corrections: StagedCorrection[];
  can: { edit: boolean; activate: boolean; evaluate: boolean };
}

/**
 * Structured prompt editor (design/02 Prompt tab, docs/archive/specs/05): edit components in
 * place, save them to the agent's draft (never the live prompt), then create
 * an immutable version with a reason or replay the draft against history.
 */
export function PromptEditor({ agentId, components, live, liveVersionId, nextVersion, compiledTokens, hashChanges, corrections, can }: Props) {
  const router = useRouter();
  const action = useAgentAction();
  const [edits, setEdits] = useState<Edits>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const saved = useMemo(() => draftTexts(components), [components]);
  const labels = useMemo(() => new Map(components.map((c) => [c.key, c.label])), [components]);
  const unsaved = effectiveEdits(saved, edits);
  const changed = draftChanges(saved, live);
  const busy = action.pending;

  const setOpenKey = (key: string, on: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  function save() {
    action.run(
      () => saveDraftAction(agentId, mergeEdits(saved, edits)),
      () => {
        setEdits({});
        setOpen(new Set());
      },
    );
  }

  function replay() {
    action.run(
      () => startEvaluationAction(agentId, REPLAY_CASES),
      (data) => router.push(agentHref(agentId, { tab: 'versions', run: data.id })),
    );
  }

  return (
    <>
      {components.map((c, i) => {
        const key = c.key;
        const text = isComponentKey(key) ? (edits[key] ?? saved[key]) : '';
        const state = isComponentKey(key) ? componentState(key, saved, live, edits) : 'live';
        const tokens = isComponentKey(key) ? (state === 'unsaved' ? estimateTokens(text) : c.tokens) : null;
        return (
          <ComponentCard
            key={key}
            index={i + 1}
            component={c}
            text={text}
            tokens={tokens}
            state={state}
            editing={open.has(key)}
            canEdit={can.edit}
            onEdit={() => setOpenKey(key, true)}
            onDone={() => setOpenKey(key, false)}
            onRevert={() => {
              setEdits((prev) => {
                const next = { ...prev };
                if (isComponentKey(key)) delete next[key];
                return next;
              });
              setOpenKey(key, false);
            }}
            onChange={(value) => isComponentKey(key) && setEdits((prev) => ({ ...prev, [key]: value }))}
          />
        );
      })}

      {action.error ? (
        <AlertBanner tone="error" style={{ marginTop: 14 }}>
          {action.error}
        </AlertBanner>
      ) : null}

      <div className="rowsplit prompt-foot">
        {can.edit ? (
          <>
            {unsaved.length ? (
              <button type="button" className="btn accent" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save draft'}
              </button>
            ) : (
              <button type="button" className="btn accent" onClick={() => setCreating(true)} disabled={busy || changed.length === 0} title={changed.length ? undefined : 'Edit and save a component first'}>
                Create version v{nextVersion}
              </button>
            )}
            {can.evaluate ? (
              <button type="button" className="btn" onClick={replay} disabled={busy || unsaved.length > 0 || changed.length === 0} title="Replays the saved draft against recent customer turns; tools are never executed">
                Run against {REPLAY_CASES} replay cases
              </button>
            ) : null}
            {unsaved.length ? (
              <button type="button" className="btn ghost" onClick={() => setEdits({})} disabled={busy}>
                Discard changes
              </button>
            ) : changed.length ? (
              <ConfirmButton label="Discard draft" buttonClass="btn ghost" title="Discard the saved draft" confirmLabel="Discard draft" tone="danger" run={() => discardDraftAction(agentId)}>
                The draft returns to the live version&apos;s components. Staged corrections stay staged; re-stage them to bring their text back.
              </ConfirmButton>
            ) : null}
          </>
        ) : null}
        <span className="sp" />
        <span className="mono-sm" aria-live="polite">
          {unsaved.length
            ? `${unsaved.length} component${unsaved.length === 1 ? '' : 's'} edited · unsaved`
            : `${changed.length} component${changed.length === 1 ? ' differs' : 's differ'} from live`}
          {compiledTokens !== null ? ` · compiled ${compiledTokens.toLocaleString('en')} tokens` : ''}
          {hashChanges === null || unsaved.length ? '' : hashChanges ? ' · prompt hash changes' : ' · prompt hash matches live'}
        </span>
      </div>

      {creating ? (
        <CreateVersionDialog
          agentId={agentId}
          nextVersion={nextVersion}
          changed={changed.map((k) => componentLabel(k, labels))}
          liveVersionId={liveVersionId}
          corrections={corrections}
          canActivate={can.activate}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
