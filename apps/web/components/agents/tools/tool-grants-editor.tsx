'use client';

import { useMemo, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { RiskBadge } from '@/components/ui/risk-badge';
import { StatusChip } from '@/components/ui/status-chip';
import { setToolGrantsAction } from '@/lib/actions/agents';
import type { AgentTool, ArgumentRule } from '../data/agent-schemas';
import { toolRisk } from '../lib/labels';
import { useAgentAction } from '../shared/use-action';
import { ArgumentRulesDialog } from './argument-rules-dialog';

type Grant = { enabled: boolean; alwaysConfirm: boolean; argumentRules: ArgumentRule[] };
type Grants = Record<string, Grant>;

const initialGrants = (tools: AgentTool[]): Grants => Object.fromEntries(tools.flatMap((t) => (t.grant ? [[t.toolId, t.grant]] : [])));
const TEMPLATE = 'minmax(0,1.5fr) minmax(0,1fr) 78px 82px 112px 150px';
const canonical = (g: Grants) => JSON.stringify(Object.keys(g).sort().map((k) => [k, g[k]]));

/**
 * Per-agent tool grants (docs/08 §3/§6): which approved tools this agent may
 * call, whether every call needs a human confirmation, and argument rules.
 * Read-only roles see the same table without controls.
 */
export function ToolGrantsEditor({ agentId, tools, canEdit }: { agentId: string; tools: AgentTool[]; canEdit: boolean }) {
  const initial = useMemo(() => initialGrants(tools), [tools]);
  const [grants, setGrants] = useState<Grants>(initial);
  const [rulesFor, setRulesFor] = useState<AgentTool | null>(null);
  const action = useAgentAction();
  const dirty = canonical(grants) !== canonical(initial);
  const orphans = tools.filter((t) => !t.eligible && grants[t.toolId]);

  const patch = (tool: AgentTool, change: Partial<Grant>) =>
    setGrants((prev) => ({ ...prev, [tool.toolId]: { ...(prev[tool.toolId] ?? { enabled: false, alwaysConfirm: false, argumentRules: [] }), ...change } }));

  function save() {
    const eligible = new Set(tools.filter((t) => t.eligible).map((t) => t.toolId));
    const list = Object.entries(grants)
      .filter(([toolId]) => eligible.has(toolId))
      .map(([toolId, g]) => ({ toolId, ...g }));
    action.run(() => setToolGrantsAction(agentId, list));
  }

  return (
    <>
      <div className="dtable" role="table" aria-label="Agent tools">
        <div className="dt-head" role="row" style={{ gridTemplateColumns: TEMPLATE }}>
          {['Tool', 'Connection', 'Side effect', 'Enabled', 'Always confirm', 'Argument rules'].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {tools.map((t) => {
          const g = grants[t.toolId];
          const label = t.title ?? t.modelName;
          return (
            <div className="dt-row" role="row" key={t.toolId} style={{ gridTemplateColumns: TEMPLATE }} data-tool={t.name}>
              <span role="cell" style={{ minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12 }}>
                  {t.modelName}
                </span>
                <span className="mono-sm row-note" title={t.description}>
                  {t.title ?? (t.description.length > 90 ? `${t.description.slice(0, 89)}…` : t.description)}
                </span>
                {!t.eligible ? <StatusChip tone="danger">no longer grantable</StatusChip> : null}
              </span>
              <span role="cell">
                <span className="mono-sm">{t.connectionName}</span>
                <span className="mono-sm row-note">{t.connectionStatus.toLowerCase()}</span>
              </span>
              <span role="cell">
                <RiskBadge risk={toolRisk(t.riskClass)} />
              </span>
              <span role="cell" className="grant-cell">
                {canEdit ? (
                  <input type="checkbox" aria-label={`Enable ${label}`} checked={g?.enabled ?? false} disabled={!t.eligible} onChange={(e) => patch(t, { enabled: e.target.checked })} />
                ) : (
                  <StatusChip tone={g?.enabled ? 'good' : 'muted'}>{g?.enabled ? 'on' : 'off'}</StatusChip>
                )}
              </span>
              <span role="cell" className="grant-cell">
                {canEdit ? (
                  <input
                    type="checkbox"
                    aria-label={`Always confirm ${label}`}
                    checked={g?.alwaysConfirm ?? false}
                    disabled={!t.eligible || !g?.enabled}
                    onChange={(e) => patch(t, { alwaysConfirm: e.target.checked })}
                  />
                ) : (
                  <span className="mono-sm">{g?.alwaysConfirm ? 'every call' : '—'}</span>
                )}
              </span>
              <span role="cell" className="grant-cell">
                <span className="mono-sm">{g?.argumentRules.length ? `${g.argumentRules.length} rule${g.argumentRules.length === 1 ? '' : 's'}` : 'none'}</span>
                {canEdit && t.eligible && g?.enabled ? (
                  <button type="button" className="btn tiny ghost" onClick={() => setRulesFor(t)} aria-label={`Argument rules for ${label}`}>
                    Edit
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      {orphans.length ? (
        <AlertBanner tone="warn" title={`${orphans.length} granted tool${orphans.length === 1 ? ' is' : 's are'} no longer grantable`} style={{ marginTop: 14 }}>
          The tool was un-approved or removed, or its connection no longer allows this agent. Saving removes these grants.
        </AlertBanner>
      ) : null}
      {action.error ? (
        <AlertBanner tone="error" style={{ marginTop: 14 }}>
          {action.error}
        </AlertBanner>
      ) : null}
      {canEdit ? (
        <div className="rowsplit" style={{ marginTop: 14 }}>
          <button type="button" className="btn accent" onClick={save} disabled={action.pending || (!dirty && orphans.length === 0)}>
            {action.pending ? 'Saving…' : 'Save tool grants'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setGrants(initial)} disabled={action.pending || !dirty}>
            Reset
          </button>
          <span className="sp" />
          <span className="mono-sm">{dirty ? 'unsaved changes' : 'saved'} · changes invalidate the agent&apos;s cached tool catalogue</span>
        </div>
      ) : null}

      {rulesFor ? (
        <ArgumentRulesDialog
          toolName={rulesFor.modelName}
          rules={grants[rulesFor.toolId]?.argumentRules ?? []}
          onApply={(argumentRules) => patch(rulesFor, { argumentRules })}
          onClose={() => setRulesFor(null)}
        />
      ) : null}
    </>
  );
}
