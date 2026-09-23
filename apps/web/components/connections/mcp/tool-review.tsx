'use client';

import { useState, type FormEvent } from 'react';
import { RiskBadge } from '@/components/ui/risk-badge';
import { StatusChip } from '@/components/ui/status-chip';
import type { HumanRole, RiskClass, Tool } from '@/lib/api/mcp';
import { RISK_BADGE, RISK_LABEL } from './meta';

export interface ToolDecision {
  approved: boolean;
  riskClass: RiskClass;
  humanRoles: HumanRole[];
}

const ROLES: Array<{ role: HumanRole; label: string }> = [
  { role: 'CS_EXEC', label: 'Exec' },
  { role: 'CS_LEAD', label: 'Lead' },
  { role: 'PLATFORM_TECH_ADMIN', label: 'Admin' },
];
const RISKS: RiskClass[] = ['READ', 'WRITE', 'SENSITIVE'];

export function initialDecisions(tools: readonly Tool[]): Record<string, ToolDecision> {
  return Object.fromEntries(
    tools
      .filter((t) => !t.removedAt)
      .map((t) => [t.id, { approved: t.approved, riskClass: t.riskClass, humanRoles: t.humanRoles.filter((r): r is HumanRole => ROLES.some((x) => x.role === r)) }]),
  );
}

interface Props {
  tools: Tool[];
  decisions: Record<string, ToolDecision>;
  onChange: (id: string, decision: ToolDecision) => void;
  readOnly: boolean;
  formId?: string;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
}

/**
 * Step 4 "Review capabilities" (design/04): every discovered tool with its
 * side-effect class, the people who may run it, and approval. Descriptions
 * are server-provided text (untrusted) and render as plain text. Tools
 * changed on the server since approval, and removed tools, are called out.
 */
export function ToolReview({ tools, decisions, onChange, readOnly, formId, onSubmit }: Props) {
  const live = tools.filter((t) => !t.removedAt);
  const removed = tools.filter((t) => t.removedAt);
  const approved = live.filter((t) => decisions[t.id]?.approved).length;
  const changed = live.filter((t) => t.changedSinceApproval).length;
  const rows = live.map((t) => {
    const d = decisions[t.id] ?? { approved: t.approved, riskClass: t.riskClass, humanRoles: [] };
    return (
      <div className={t.changedSinceApproval ? 'cap tool-row changed' : 'cap tool-row'} key={t.id} data-tool={t.name}>
        <input type="checkbox" checked={d.approved} disabled={readOnly} aria-label={`Approve ${t.name}`} onChange={(e) => onChange(t.id, { ...d, approved: e.target.checked })} />
        <span style={{ minWidth: 0 }}>
          <span className="cn">{t.name}</span>
          {t.changedSinceApproval ? (
            <>
              {' '}
              <StatusChip tone="warn">changed since approval</StatusChip>
            </>
          ) : null}
          <span className="cd">{t.title ? `${t.title} — ` : ''}{t.description || 'No description provided by the server.'}</span>
          <span className="mono-sm tool-meta">
            model name {t.modelName}
            {t.suggestedRisk !== d.riskClass ? ` · server suggests ${RISK_BADGE[t.suggestedRisk]}` : ''}
            {t.requiredScopes.length ? ` · scopes ${t.requiredScopes.join(', ')}` : ''}
          </span>
          <span className="tool-roles" role="group" aria-label={`People who may run ${t.name}`}>
            <span className="mono-sm">people:</span>
            {ROLES.map((r) => (
              <label key={r.role}>
                <input
                  type="checkbox"
                  disabled={readOnly}
                  checked={d.humanRoles.includes(r.role)}
                  onChange={(e) => onChange(t.id, { ...d, humanRoles: e.target.checked ? [...d.humanRoles, r.role] : d.humanRoles.filter((x) => x !== r.role) })}
                />
                {r.label}
              </label>
            ))}
          </span>
        </span>
        {readOnly ? (
          <RiskBadge risk={RISK_BADGE[d.riskClass]} />
        ) : (
          <select className="risk-select" aria-label={`Side-effect class of ${t.name}`} value={d.riskClass} onChange={(e) => onChange(t.id, { ...d, riskClass: e.target.value as RiskClass })}>
            {RISKS.map((r) => (
              <option key={r} value={r}>
                {RISK_LABEL[r]}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  });

  const body = (
    <>
      <div className="rowsplit">
        <span className="mono-sm">
          {live.length} tools · {approved} approved{changed ? ` · ${changed} changed since approval` : ''}
        </span>
        <span className="sp" />
        <span className="mono-sm">unapproved tools stay invisible to every agent</span>
      </div>
      {live.length ? <div>{rows}</div> : <span className="mono-sm">The server listed no tools.</span>}
      {removed.length ? (
        <div className="removed-tools" aria-label="Removed tools">
          <span className="mono-sm">Removed from the server (kept for audit, never exposed):</span>
          {removed.map((t) => (
            <div className="cap tool-row removed" key={t.id}>
              <span />
              <span>
                <span className="cn">{t.name}</span> <StatusChip tone="muted">removed</StatusChip>
              </span>
              <RiskBadge risk={RISK_BADGE[t.riskClass]} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
  if (!formId) return body;
  return (
    <form id={formId} noValidate onSubmit={onSubmit} style={{ display: 'grid', gap: 10 }}>
      {body}
    </form>
  );
}
