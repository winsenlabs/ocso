'use client';

import { useState } from 'react';
import { KeyValue } from '@/components/ui/key-value';
import { approveConnectionAction } from '@/lib/actions/mcp';
import type { AgentLite, ConfirmationPolicy, Connection, Tool } from '@/lib/api/mcp';
import { Input } from '../../profiles/profile-fields';
import { CONFIRMATION_LABEL } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';

/** Step 5 "Approve": which agents may use the connection, confirmation policy, claims and health interval. */
export function StepApprove({ connection, tools, agents, api }: { connection: Connection | null; tools: Tool[]; agents: AgentLite[]; api: StepApi }) {
  const initialAgents = connection && connection.allowedAgentIds !== '*' ? connection.allowedAgentIds : [];
  const [anyAgent, setAnyAgent] = useState(connection?.allowedAgentIds === '*' || (!connection?.approvedAt && agents.length === 0));
  const [chosen, setChosen] = useState<string[]>(initialAgents);
  const [policy, setPolicy] = useState<ConfirmationPolicy>(connection?.confirmationPolicy ?? 'SENSITIVE_ONLY');
  const [claims, setClaims] = useState(connection?.sendCustomerClaims ?? false);
  const [healthSeconds, setHealthSeconds] = useState(String(connection?.healthCheckSeconds ?? 60));
  if (!connection) return <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.go('url'))} />;
  const template = connection.kind === 'TEMPLATE';
  const live = tools.filter((t) => !t.removedAt);
  const approved = live.filter((t) => t.approved).length;
  const sensitive = live.filter((t) => t.approved && t.riskClass === 'SENSITIVE').length;
  const who = template
    ? 'no virtual agent (user-scoped connections serve only the person who connects)'
    : anyAgent
      ? 'any agent a Lead enables it for'
      : chosen.length
        ? agents
            .filter((a) => chosen.includes(a.id))
            .map((a) => a.name)
            .join(', ')
        : 'no agent yet';
  const id = connection.id;

  function submit() {
    const seconds = Number(healthSeconds);
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 3600) {
      api.fail('Health check interval must be a whole number of seconds between 15 and 3600.');
      return;
    }
    api.run(async () => {
      const r = await approveConnectionAction({
        id,
        allowedAgentIds: template ? [] : anyAgent ? '*' : chosen,
        confirmationPolicy: policy,
        sendCustomerClaims: template ? false : claims,
        healthCheckSeconds: seconds,
      });
      if (!r.ok) api.fail(r.message);
      else {
        api.notify(null);
        api.go('active');
      }
    });
  }

  return (
    <form id={STEP_FORM} noValidate onSubmit={(e) => (e.preventDefault(), submit())} style={{ display: 'grid', gap: 14 }}>
      <div className="fld-row">
        <div className="fld">
          <label htmlFor="ap-scope">Connection scope</label>
          <input id="ap-scope" value={template ? 'User-scoped — each user connects their own' : 'Shared — available subject to policy'} disabled />
        </div>
        <div className="fld">
          <label htmlFor="ap-policy">Confirmation policy</label>
          <select id="ap-policy" value={policy} onChange={(e) => setPolicy(e.target.value as ConfirmationPolicy)}>
            {(Object.keys(CONFIRMATION_LABEL) as ConfirmationPolicy[]).map((p) => (
              <option key={p} value={p}>
                {CONFIRMATION_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {template ? (
        <span className="mono-sm">Published as a template: CS users connect their own account from Connections → My connections. Virtual agents never use it.</span>
      ) : (
        <fieldset className="fld" style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, padding: 0, marginBottom: 5 }}>Agents allowed to use this connection</legend>
          <label className="toggle-row">
            <input type="checkbox" checked={anyAgent} onChange={(e) => setAnyAgent(e.target.checked)} />
            Any agent a Lead enables it for (per-agent tool grants still apply)
          </label>
          {!anyAgent ? (
            agents.length ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }} role="group" aria-label="Agents">
                {agents.map((a) => {
                  const on = chosen.includes(a.id);
                  return (
                    <button key={a.id} type="button" className={on ? 'fchip active' : 'fchip'} aria-pressed={on} onClick={() => setChosen(on ? chosen.filter((x) => x !== a.id) : [...chosen, a.id])}>
                      {a.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="mono-sm">No virtual agents exist yet. Allow any agent, or approve now and name agents later.</span>
            )
          ) : null}
          <label className="toggle-row" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={claims} onChange={(e) => setClaims(e.target.checked)} />
            Send signed customer identity claims with each call
          </label>
        </fieldset>
      )}
      <Input id="ap-interval" label="Health check every (seconds)" type="number" value={healthSeconds} onChange={setHealthSeconds} hint="15–3600 · the connection's status follows each check" />
      <KeyValue
        items={[
          { k: 'tools', v: `${approved} approved · ${live.length - approved} held back` },
          { k: 'credential', v: connection.auth.strategy === 'NONE' ? 'none' : 'secret reference · resolved only in trusted code' },
          { k: 'audit', v: 'every call attributed to the agent and the acting human' },
        ]}
      />
      <div className="confirm">
        <span className="cl">approve connection</span>
        <span className="cx">
          {`This grants ${who} access to ${approved} ${connection.name} tool${approved === 1 ? '' : 's'}.`}
          {sensitive && policy !== 'NONE' ? ` ${sensitive} sensitive tool${sensitive === 1 ? '' : 's'} stay behind a human confirmation.` : ''}
          {policy === 'NONE' ? ' No confirmation is required for any write — not recommended.' : ''}
        </span>
      </div>
    </form>
  );
}
