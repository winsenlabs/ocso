'use client';

import type { AskStep, ClassifyStep, KnownStep, MessageSpec, RouterStep } from '@ocso/domain';
import { MessageEditor, type TemplateChannel } from './message-editor';
import { slug } from './lib/definition';

export interface Option {
  value: string;
  label: string;
}

interface Common {
  index: number;
  count: number;
  canEdit: boolean;
  onChange: (step: RouterStep) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}

const KIND_TITLE: Readonly<Record<RouterStep['kind'], string>> = { ASK: 'Ask (menu)', CLASSIFY: 'Classify (model)', KNOWN: 'Known fact' };

/** One router step (PM/research/11 §5.2): ASK a menu, CLASSIFY with a model, or take a KNOWN customer fact. */
export function StepEditor({
  step,
  profiles,
  channels,
  routerName,
  persist,
  ...c
}: Common & { step: RouterStep; profiles: Option[]; channels: readonly TemplateChannel[]; routerName: string; persist: (step: RouterStep) => Promise<boolean> }) {
  const pid = `rt-step-${c.index}`;
  return (
    <section className="rt-step" aria-label={`Step ${c.index + 1}: ${KIND_TITLE[step.kind]}`}>
      <div className="rowsplit" style={{ gap: 8 }}>
        <b>
          {c.index + 1}. {KIND_TITLE[step.kind]}
        </b>
        <span className="mono-sm">sets {step.attribute}</span>
        <span className="sp" />
        {c.canEdit ? (
          <>
            <button type="button" className="btn tiny ghost" aria-label={`Move step ${c.index + 1} up`} disabled={c.index === 0} onClick={() => c.onMove(-1)}>
              ↑
            </button>
            <button type="button" className="btn tiny ghost" aria-label={`Move step ${c.index + 1} down`} disabled={c.index === c.count - 1} onClick={() => c.onMove(1)}>
              ↓
            </button>
            <button type="button" className="btn tiny ghost" aria-label={`Remove step ${c.index + 1}`} onClick={c.onRemove}>
              Remove
            </button>
          </>
        ) : null}
      </div>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor={`${pid}-attr`}>Attribute</label>
          <input id={`${pid}-attr`} value={step.attribute} disabled={!c.canEdit} onChange={(e) => c.onChange({ ...step, attribute: e.target.value.trim() })} />
        </div>
        {step.kind !== 'KNOWN' ? (
          <label className="toggle-row" style={{ alignSelf: 'center' }}>
            <input type="checkbox" checked={step.skipIfKnown} disabled={!c.canEdit} onChange={(e) => c.onChange({ ...step, skipIfKnown: e.target.checked })} />
            Skip when already known
          </label>
        ) : null}
      </div>
      {step.kind === 'ASK' ? <AskFields step={step} pid={pid} channels={channels} routerName={routerName} persist={persist} {...c} /> : null}
      {step.kind === 'CLASSIFY' ? <ClassifyFields step={step} pid={pid} profiles={profiles} {...c} /> : null}
      {step.kind === 'KNOWN' ? <KnownFields step={step} pid={pid} {...c} /> : null}
    </section>
  );
}

function AskFields({ step, pid, channels, routerName, persist, canEdit, onChange }: Common & { step: AskStep; pid: string; channels: readonly TemplateChannel[]; routerName: string; persist: (step: RouterStep) => Promise<boolean> }) {
  const setOption = (i: number, patch: Partial<AskStep['options'][number]>) => onChange({ ...step, options: step.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  return (
    <>
      <MessageEditor
        id={`${pid}-prompt`}
        label="Question"
        spec={step.prompt}
        onChange={(prompt: MessageSpec) => onChange({ ...step, prompt })}
        channels={channels}
        routerName={routerName}
        stepId={step.id}
        canEdit={canEdit}
        onMapped={(prompt) => persist({ ...step, prompt })}
      />
      <div className="fld">
        <span className="rt-lbl">Options (label shown · value stored · synonyms)</span>
        {step.options.map((o, i) => (
          <div key={i} className="rowsplit" style={{ gap: 6 }}>
            <input aria-label={`Option ${i + 1} label`} value={o.label} disabled={!canEdit} onChange={(e) => setOption(i, { label: e.target.value, ...(o.value === slug(o.label, '') || !o.value ? { value: slug(e.target.value, `option_${i + 1}`) } : {}) })} />
            <input aria-label={`Option ${i + 1} value`} value={o.value} disabled={!canEdit} onChange={(e) => setOption(i, { value: e.target.value.trim() })} />
            <input
              aria-label={`Option ${i + 1} synonyms`}
              placeholder="synonyms, comma separated"
              value={(o.synonyms ?? []).join(', ')}
              disabled={!canEdit}
              onChange={(e) => {
                const synonyms = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
                setOption(i, synonyms.length ? { synonyms } : { synonyms: [] });
              }}
            />
            {canEdit && step.options.length > 2 ? (
              <button type="button" className="btn tiny ghost" aria-label={`Remove option ${i + 1}`} onClick={() => onChange({ ...step, options: step.options.filter((_, j) => j !== i) })}>
                ×
              </button>
            ) : null}
          </div>
        ))}
        {canEdit && step.options.length < 10 ? (
          <button type="button" className="btn tiny" style={{ justifySelf: 'start' }} onClick={() => onChange({ ...step, options: [...step.options, { value: `option_${step.options.length + 1}`, label: `Option ${step.options.length + 1}` }] })}>
            Add option
          </button>
        ) : null}
      </div>
      <div className="fld" style={{ maxWidth: 220 }}>
        <label htmlFor={`${pid}-attempts`}>Ask at most (times)</label>
        <input id={`${pid}-attempts`} type="number" min={1} max={5} value={step.maxAttempts} disabled={!canEdit} onChange={(e) => onChange({ ...step, maxAttempts: Number(e.target.value) })} />
      </div>
    </>
  );
}

function ClassifyFields({ step, pid, profiles, canEdit, onChange }: Common & { step: ClassifyStep; pid: string; profiles: Option[] }) {
  const setLabel = (i: number, patch: Partial<ClassifyStep['labels'][number]>) => onChange({ ...step, labels: step.labels.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  return (
    <>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor={`${pid}-profile`}>Model profile</label>
          <select id={`${pid}-profile`} value={step.modelProfileId} disabled={!canEdit} onChange={(e) => onChange({ ...step, modelProfileId: e.target.value })}>
            <option value="">Choose a model profile</option>
            {profiles.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fld">
          <label htmlFor={`${pid}-conf`}>Minimum confidence</label>
          <input id={`${pid}-conf`} type="number" min={0} max={1} step={0.05} value={step.minConfidence} disabled={!canEdit} onChange={(e) => onChange({ ...step, minConfidence: Number(e.target.value) })} />
        </div>
        <div className="fld">
          <label htmlFor={`${pid}-follow`}>Follow-up questions</label>
          <input id={`${pid}-follow`} type="number" min={0} max={3} value={step.maxFollowUps} disabled={!canEdit} onChange={(e) => onChange({ ...step, maxFollowUps: Number(e.target.value) })} />
        </div>
      </div>
      <div className="fld">
        <label htmlFor={`${pid}-instr`}>Instructions</label>
        <textarea id={`${pid}-instr`} rows={2} value={step.instructions} disabled={!canEdit} onChange={(e) => onChange({ ...step, instructions: e.target.value })} />
      </div>
      <div className="fld">
        <span className="rt-lbl">Labels (value · when to choose it)</span>
        {step.labels.map((l, i) => (
          <div key={i} className="rowsplit" style={{ gap: 6 }}>
            <input aria-label={`Label ${i + 1} value`} value={l.value} disabled={!canEdit} onChange={(e) => setLabel(i, { value: e.target.value.trim() })} />
            <input aria-label={`Label ${i + 1} description`} style={{ flex: 1 }} value={l.description} disabled={!canEdit} onChange={(e) => setLabel(i, { description: e.target.value })} />
            {canEdit && step.labels.length > 2 ? (
              <button type="button" className="btn tiny ghost" aria-label={`Remove label ${i + 1}`} onClick={() => onChange({ ...step, labels: step.labels.filter((_, j) => j !== i) })}>
                ×
              </button>
            ) : null}
          </div>
        ))}
        {canEdit && step.labels.length < 20 ? (
          <button type="button" className="btn tiny" style={{ justifySelf: 'start' }} onClick={() => onChange({ ...step, labels: [...step.labels, { value: `label_${step.labels.length + 1}`, description: '' }] })}>
            Add label
          </button>
        ) : null}
      </div>
    </>
  );
}

function KnownFields({ step, pid, canEdit, onChange }: Common & { step: KnownStep; pid: string }) {
  const custom = step.from !== 'customer.language';
  return (
    <div className="fld-row">
      <div className="fld">
        <label htmlFor={`${pid}-from`}>Taken from</label>
        <select id={`${pid}-from`} value={custom ? 'attribute' : 'language'} disabled={!canEdit} onChange={(e) => onChange({ ...step, from: e.target.value === 'language' ? 'customer.language' : `customer.attribute:${step.attribute}` })}>
          <option value="language">The customer’s language</option>
          <option value="attribute">A customer attribute</option>
        </select>
      </div>
      {custom ? (
        <div className="fld">
          <label htmlFor={`${pid}-key`}>Customer attribute</label>
          <input id={`${pid}-key`} value={step.from.replace(/^customer\.attribute:/, '')} disabled={!canEdit} onChange={(e) => onChange({ ...step, from: `customer.attribute:${e.target.value.trim()}` })} />
        </div>
      ) : null}
    </div>
  );
}
