'use client';

import { useState } from 'react';
import type { RouterDefinition, RouterRule } from '@ocso/domain';
import { formatWhen, parseWhen, rulesFromQueues, stepAttributes, unreachableRules, type QueueRef } from './lib/definition';

export interface QueueChoice extends QueueRef {
  agentName: string | null;
  approved: boolean;
}

/** One condition row: its text is kept as typed until it parses, so half-typed conditions are not lost. */
function RuleRow({ rule, index, count, queues, canEdit, unreachable, onChange, onMove, onRemove }: {
  rule: RouterRule;
  index: number;
  count: number;
  queues: readonly QueueChoice[];
  canEdit: boolean;
  unreachable: boolean;
  onChange: (rule: RouterRule) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(formatWhen(rule.when));
  const parsed = parseWhen(text);
  return (
    <div className="rt-rule" role="group" aria-label={`Rule ${index + 1}`}>
      <span className="mono-sm">{index + 1}.</span>
      <input
        aria-label={`Rule ${index + 1} conditions`}
        value={text}
        placeholder="language=ta, product=sales|loans (blank = everyone)"
        disabled={!canEdit}
        aria-invalid={parsed.ok ? undefined : true}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseWhen(e.target.value);
          if (next.ok) onChange({ ...rule, when: next.when });
        }}
      />
      <span className="mono-sm">→</span>
      <select aria-label={`Rule ${index + 1} queue`} value={rule.queueId} disabled={!canEdit} onChange={(e) => onChange({ ...rule, queueId: e.target.value })}>
        {queues.map((q) => (
          <option key={q.id} value={q.id}>
            {q.name}
            {q.agentName ? ` · ${q.agentName}` : ' · no agent'}
            {q.approved ? '' : ' (not approved)'}
          </option>
        ))}
      </select>
      {canEdit ? (
        <span className="rowsplit" style={{ gap: 2 }}>
          <button type="button" className="btn tiny ghost" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button type="button" className="btn tiny ghost" aria-label={`Move rule ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </button>
          <button type="button" className="btn tiny ghost" aria-label={`Remove rule ${index + 1}`} onClick={onRemove}>
            ×
          </button>
        </span>
      ) : null}
      {!parsed.ok ? (
        <span className="err" role="alert" style={{ gridColumn: '1 / -1' }}>
          {parsed.message}
        </span>
      ) : unreachable ? (
        <span className="hint" style={{ gridColumn: '1 / -1', color: 'var(--warn)' }}>
          no step sets {Object.keys(rule.when).join(', ')}: this rule never matches
        </span>
      ) : null}
    </div>
  );
}

/**
 * Rules over queue attributes (PM/research/11 §5.2): first match wins, every
 * condition must hold, `a|b` matches either. "Rules from queue attributes"
 * writes one rule per queue whose attributes the steps set.
 */
export function RulesEditor({ def, queues, canEdit, onChange }: { def: RouterDefinition; queues: readonly QueueChoice[]; canEdit: boolean; onChange: (rules: RouterRule[]) => void }) {
  const [generation, setGeneration] = useState(0);
  const unreachable = new Set(unreachableRules(def));
  const move = (i: number, d: -1 | 1) => {
    const next = [...def.rules];
    const [r] = next.splice(i, 1);
    next.splice(i + d, 0, r!);
    onChange(next);
    setGeneration((g) => g + 1);
  };
  const attrs = stepAttributes(def);
  return (
    <div className="rt-rules">
      {def.rules.length === 0 ? <p className="mono-sm">No rules: everyone goes to the fallback queue.</p> : null}
      {def.rules.map((rule, i) => (
        <RuleRow
          key={`${generation}-${i}`}
          rule={rule}
          index={i}
          count={def.rules.length}
          queues={queues}
          canEdit={canEdit}
          unreachable={unreachable.has(i)}
          onChange={(r) => onChange(def.rules.map((x, j) => (j === i ? r : x)))}
          onMove={(d) => move(i, d)}
          onRemove={() => {
            onChange(def.rules.filter((_, j) => j !== i));
            setGeneration((g) => g + 1);
          }}
        />
      ))}
      {canEdit ? (
        <div className="rowsplit" style={{ gap: 6 }}>
          <button type="button" className="btn tiny" disabled={!queues.length || def.rules.length >= 100} onClick={() => onChange([...def.rules, { when: attrs[0] ? { [attrs[0]]: 'value' } : {}, queueId: queues[0]!.id }])}>
            Add rule
          </button>
          <button
            type="button"
            className="btn tiny"
            disabled={!attrs.length}
            title={attrs.length ? `One rule per queue whose attributes are among: ${attrs.join(', ')}` : 'Add a step that sets an attribute first'}
            onClick={() => {
              onChange(rulesFromQueues(def, queues));
              setGeneration((g) => g + 1);
            }}
          >
            Rules from queue attributes
          </button>
        </div>
      ) : null}
    </div>
  );
}
