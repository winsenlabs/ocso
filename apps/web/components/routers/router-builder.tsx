'use client';

import { useState } from 'react';
import type { RouterDefinition, RouterStep } from '@ocso/domain';
import { AlertBanner } from '@/components/ui/alert-banner';
import { freezeRouterVersionAction, saveRouterDraftAction } from '@/lib/actions/routers';
import { definitionIssues, newStep, RETURNING_UNITS, type StepKind } from './lib/definition';
import { MessageEditor, type TemplateChannel } from './message-editor';
import { RulesEditor, type QueueChoice } from './rules-editor';
import { StepEditor, type Option } from './step-editor';

/**
 * The router builder (PM/research/11 §5.7): edits the draft — steps (ASK /
 * CLASSIFY / KNOWN), rules over queue attributes, the fallback queue,
 * returning customers (value + unit) and the timeout. The draft is inert:
 * saving is direct; freezing makes an immutable version that goes live only
 * through an approval (versions panel).
 */
export function RouterBuilder({
  routerId,
  routerName,
  initial,
  queues,
  profiles,
  channels,
  canEdit,
  problems,
}: {
  routerId: string;
  routerName: string;
  initial: RouterDefinition;
  queues: QueueChoice[];
  profiles: Option[];
  channels: TemplateChannel[];
  canEdit: boolean;
  problems: Array<{ code: string; message: string }>;
}) {
  const [def, setDef] = useState<RouterDefinition>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const issues = definitionIssues(def);

  const edit = (next: RouterDefinition) => {
    setDef(next);
    setDirty(true);
    setNotice(null);
  };
  const setStep = (i: number, step: RouterStep) => edit({ ...def, steps: def.steps.map((s, j) => (j === i ? step : s)) });
  const moveStep = (i: number, d: -1 | 1) => {
    const steps = [...def.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + d, 0, s!);
    edit({ ...def, steps });
  };

  async function save(next: RouterDefinition = def): Promise<boolean> {
    setBusy(true);
    const r = await saveRouterDraftAction(routerId, next);
    setBusy(false);
    if (!r.ok) {
      setNotice({ tone: 'error', text: r.message });
      return false;
    }
    setDirty(false);
    setNotice({ tone: 'info', text: 'Draft saved. It routes nothing until a version of it is approved.' });
    return true;
  }

  async function freeze() {
    if (dirty && !(await save())) return;
    setBusy(true);
    const r = await freezeRouterVersionAction(routerId, reason.trim());
    setBusy(false);
    setNotice(r.ok ? { tone: 'info', text: `Saved as version ${r.data.version}. Activate it below — a checker approves it before customers see it.` } : { tone: 'error', text: r.message });
    if (r.ok) setReason('');
  }

  const persistStep = (i: number) => (step: RouterStep) => {
    const next = { ...def, steps: def.steps.map((s, j) => (j === i ? step : s)) };
    setDef(next);
    return save(next);
  };

  return (
    <section className="rt-builder" aria-label="Router draft">
      {notice ? (
        <AlertBanner tone={notice.tone} style={{ margin: 0 }}>
          {notice.text}
        </AlertBanner>
      ) : null}
      {problems.length ? (
        <AlertBanner tone="warn" style={{ margin: 0 }}>
          Before this draft can go live: {problems.map((p) => p.message).join('; ')}
        </AlertBanner>
      ) : null}

      <h3 className="rt-h">Steps</h3>
      {def.steps.length === 0 ? <p className="mono-sm">No steps: a pass-through router — every customer goes straight to the fallback queue.</p> : null}
      {def.steps.map((step, i) => (
        <StepEditor
          key={`${i}-${step.id}`}
          step={step}
          index={i}
          count={def.steps.length}
          canEdit={canEdit}
          profiles={profiles}
          channels={channels}
          routerName={routerName}
          onChange={(s) => setStep(i, s)}
          onMove={(d) => moveStep(i, d)}
          onRemove={() => edit({ ...def, steps: def.steps.filter((_, j) => j !== i) })}
          persist={persistStep(i)}
        />
      ))}
      {canEdit && def.steps.length < 10 ? (
        <div className="rowsplit" style={{ gap: 6 }}>
          {(['ASK', 'CLASSIFY', 'KNOWN'] as StepKind[]).map((k) => (
            <button key={k} type="button" className="btn tiny" onClick={() => edit({ ...def, steps: [...def.steps, newStep(k, def.steps, profiles[0]?.value ?? '')] })}>
              {k === 'ASK' ? 'Add menu question' : k === 'CLASSIFY' ? 'Add model classifier' : 'Add known fact'}
            </button>
          ))}
        </div>
      ) : null}

      <h3 className="rt-h">Rules</h3>
      <RulesEditor def={def} queues={queues} canEdit={canEdit} onChange={(rules) => edit({ ...def, rules })} />

      <div className="fld-row">
        <div className="fld">
          <label htmlFor="rt-fallback">Fallback queue</label>
          <select id="rt-fallback" value={def.fallbackQueueId} disabled={!canEdit} onChange={(e) => edit({ ...def, fallbackQueueId: e.target.value })}>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
                {q.agentName ? ` · ${q.agentName}` : ' · no agent'}
              </option>
            ))}
          </select>
          <span className="hint">no rule matched, nobody answered in time, or the menu gave up</span>
        </div>
        <div className="fld">
          <label htmlFor="rt-timeout">No answer after (minutes)</label>
          <input id="rt-timeout" type="number" min={1} max={1440} value={def.timeoutMinutes} disabled={!canEdit} onChange={(e) => edit({ ...def, timeoutMinutes: Number(e.target.value) })} />
          <span className="hint">then the fallback queue</span>
        </div>
      </div>

      <h3 className="rt-h">Returning customers</h3>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={def.returning !== null}
          disabled={!canEdit}
          onChange={(e) =>
            edit({ ...def, returning: e.target.checked ? { askAfter: { value: 3, unit: 'DAYS' }, prompt: { text: 'Welcome back! Continue where we left off, or start something new?' }, continueLabel: 'Continue', newLabel: 'New' } : null })
          }
        />
        Ask “continue or new?” after a gap
      </label>
      {def.returning ? (
        <>
          <div className="fld-row">
            <div className="fld">
              <label htmlFor="rt-ret-value">Ask after</label>
              <input id="rt-ret-value" type="number" min={1} max={1000} value={def.returning.askAfter.value} disabled={!canEdit} onChange={(e) => edit({ ...def, returning: { ...def.returning!, askAfter: { ...def.returning!.askAfter, value: Number(e.target.value) } } })} />
            </div>
            <div className="fld">
              <label htmlFor="rt-ret-unit">Unit</label>
              <select id="rt-ret-unit" value={def.returning.askAfter.unit} disabled={!canEdit} onChange={(e) => edit({ ...def, returning: { ...def.returning!, askAfter: { ...def.returning!.askAfter, unit: e.target.value as (typeof RETURNING_UNITS)[number] } } })}>
                {RETURNING_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u.toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="rt-ret-continue">Continue label</label>
              <input id="rt-ret-continue" value={def.returning.continueLabel} maxLength={20} disabled={!canEdit} onChange={(e) => edit({ ...def, returning: { ...def.returning!, continueLabel: e.target.value } })} />
            </div>
            <div className="fld">
              <label htmlFor="rt-ret-new">New label</label>
              <input id="rt-ret-new" value={def.returning.newLabel} maxLength={20} disabled={!canEdit} onChange={(e) => edit({ ...def, returning: { ...def.returning!, newLabel: e.target.value } })} />
            </div>
          </div>
          <MessageEditor
            id="rt-ret-prompt"
            label="Continue-or-new question"
            spec={def.returning.prompt}
            onChange={(prompt) => edit({ ...def, returning: { ...def.returning!, prompt } })}
            channels={channels}
            routerName={routerName}
            stepId="returning"
            canEdit={canEdit}
            onMapped={(prompt) => {
              const next = { ...def, returning: { ...def.returning!, prompt } };
              setDef(next);
              return save(next);
            }}
          />
        </>
      ) : null}

      {issues.length ? (
        <ul className="rt-issues" aria-label="Problems in the draft">
          {issues.slice(0, 8).map((i) => (
            <li key={`${i.path}:${i.message}`} className="err">
              {i.path ? `${i.path}: ` : ''}
              {i.message}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div className="rowsplit rt-save" style={{ gap: 8 }}>
          <button type="button" className="btn" disabled={busy || !dirty || issues.length > 0} onClick={() => void save()}>
            {busy ? 'Saving…' : dirty ? 'Save draft' : 'Draft saved'}
          </button>
          <span className="sp" />
          <input aria-label="Version note" placeholder="What changed (version note)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn accent" disabled={busy || issues.length > 0} onClick={() => void freeze()}>
            Save as new version
          </button>
        </div>
      ) : null}
    </section>
  );
}
