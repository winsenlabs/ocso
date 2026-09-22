'use client';

import { useMemo, useState, useTransition } from 'react';
import { RiskBadge } from '@/components/ui/risk-badge';
import { runToolAction } from '@/lib/actions/conversations';
import type { WorkspaceTool } from '@/lib/api/conversations';
import { buildArgs, schemaFields, type FormField, type FormValues } from './lib/schema-form';
import { factsOf, riskOf } from './lib/timeline';

export interface ToolActionProps {
  conversationId: string;
  tools: WorkspaceTool[];
  canRun: boolean;
}

/**
 * Composer "Tool action" (design/01): pick an approved tool, fill its
 * JSON-schema form and run it as yourself. Sensitive tools need an explicit
 * "Confirm and run" step (docs/08 §7) — the run is attributed to you and audited.
 */
export function ToolAction({ conversationId, tools, canRun }: ToolActionProps) {
  const [toolId, setToolId] = useState<string | null>(null);
  const tool = tools.find((t) => t.id === toolId) ?? null;

  if (!canRun) return <p className="mono-sm">Your role cannot run tools from the workspace.</p>;
  if (tools.length === 0) {
    return <p className="mono-sm">No tools are approved for your role. A Platform Tech Admin approves MCP tools; a CS Lead enables them.</p>;
  }
  if (!tool) {
    return (
      <div className="toolpick" role="group" aria-label="Approved tools">
        {tools.map((t) => (
          <button key={t.id} type="button" className="tool-opt" onClick={() => setToolId(t.id)}>
            <span>
              <span className="tn">{t.name}</span>
              <span className="td">
                {t.description || 'No description'} · {t.connection}
              </span>
            </span>
            <RiskBadge risk={riskOf(t.riskClass)} />
          </button>
        ))}
      </div>
    );
  }
  return <ToolForm key={tool.id} conversationId={conversationId} tool={tool} onBack={() => setToolId(null)} />;
}

function ToolForm({ conversationId, tool, onBack }: { conversationId: string; tool: WorkspaceTool; onBack: () => void }) {
  const fields = useMemo(() => schemaFields(tool.inputSchema), [tool.inputSchema]);
  const [values, setValues] = useState<FormValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sensitive = tool.riskClass === 'SENSITIVE';

  const execute = (args: Record<string, unknown>, confirmed: boolean) =>
    start(async () => {
      setResult(null);
      const res = await runToolAction(conversationId, tool.id, args, confirmed);
      if (!res.ok) {
        if (res.code === 'confirmation_required') return setConfirming(args);
        setResult({ tone: 'fail', text: res.message });
        return;
      }
      setConfirming(null);
      setResult(res.status === 'SUCCEEDED' ? { tone: 'ok', text: `${tool.name} succeeded — the result is in the timeline.` } : { tone: 'fail', text: `${tool.name} failed${res.detail ? `: ${res.detail}` : ''}` });
      if (res.status === 'SUCCEEDED') setValues({});
    });

  const submit = () => {
    const built = buildArgs(fields, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length) return;
    if (sensitive) setConfirming(built.args);
    else execute(built.args, false);
  };

  return (
    <div className="toolform">
      <div className="rowsplit">
        <b className="mono" style={{ fontSize: 12 }}>
          {tool.name}
        </b>
        <RiskBadge risk={riskOf(tool.riskClass)} />
        <span className="mono-sm">{tool.connection}</span>
        <span className="sp" />
        <button type="button" className="btn tiny ghost" onClick={onBack} disabled={pending}>
          Choose another tool
        </button>
      </div>
      {confirming ? (
        <div className="confirm">
          <span className="cl">confirm sensitive action</span>
          <span className="cx">
            <b>{tool.name}</b> · {(tool.description || 'sensitive action').replace(/\.+$/, '')}. Runs as you, cannot be taken back once the external system acts, and is written to the audit log.
          </span>
          <span className="kvs">
            {factsOf(confirming, 10).map((f) => (
              <span key={f.k}>
                {f.k} <b>{f.v}</b>
              </span>
            ))}
          </span>
          <span className="rowsplit">
            <button type="button" className="btn tiny accent" disabled={pending} onClick={() => execute(confirming, true)}>
              {pending ? 'Running…' : 'Confirm and run'}
            </button>
            <button type="button" className="btn tiny ghost" disabled={pending} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </span>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          style={{ display: 'grid', gap: 10 }}
        >
          {fields.length === 0 ? <p className="mono-sm">This tool takes no arguments.</p> : null}
          <div className="fld-row">
            {fields.map((f) => (
              <SchemaInput key={f.name} field={f} value={values[f.name]} error={errors[f.name]} onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))} />
            ))}
          </div>
          <span className="rowsplit">
            <button type="submit" className="btn tiny accent" disabled={pending}>
              {pending ? 'Running…' : sensitive ? 'Review and confirm' : 'Run tool'}
            </button>
            <span className="mono-sm">runs as you · recorded in the timeline{tool.riskClass !== 'READ' ? ' and audit log' : ''}</span>
          </span>
        </form>
      )}
      {result ? (
        <span role={result.tone === 'fail' ? 'alert' : 'status'} className="mono-sm" style={{ color: result.tone === 'fail' ? 'var(--danger)' : 'var(--good)' }}>
          {result.text}
        </span>
      ) : null}
    </div>
  );
}

function SchemaInput({ field, value, error, onChange }: { field: FormField; value: string | boolean | undefined; error: string | undefined; onChange: (v: string | boolean) => void }) {
  const id = `tool-arg-${field.name}`;
  const label = `${field.label}${field.required ? '' : ' (optional)'}`;
  const hint = field.description ? <span className="hint">{field.description}</span> : null;
  const err = error ? (
    <span className="err" role="alert">
      {error}
    </span>
  ) : null;
  if (field.kind === 'boolean') {
    return (
      <label className="toggle-row" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      {field.kind === 'enum' ? (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}>
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.kind === 'json' ? (
        <textarea id={id} rows={3} value={text} onChange={(e) => onChange(e.target.value)} placeholder="JSON" aria-invalid={error ? true : undefined} />
      ) : (
        <input
          id={id}
          type={field.kind === 'date' ? 'date' : 'text'}
          inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.kind === 'list' ? 'comma-separated' : undefined}
          aria-invalid={error ? true : undefined}
        />
      )}
      {hint}
      {err}
    </div>
  );
}
