'use client';

import Link from 'next/link';
import { useState, useTransition, type ReactNode } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Drawer } from '@/components/ui/drawer';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { checkHealthAction, classifyToolsAction, deleteConnectionAction, rediscoverAction, setConnectionEnabledAction } from '@/lib/actions/mcp';
import type { AgentLite, Connection, Tool } from '@/lib/api/mcp';
import { formatAge, formatLatency } from '@/lib/format';
import { ConfirmAction } from '../confirm-action';
import { useCloseTo } from '../routed-modal';
import { connectionsHref } from '../url';
import { CONFIRMATION_LABEL, authLabel, connectionStatus, scopeLabel, serverInfoSummary } from './meta';
import { ToolReview, initialDecisions, type ToolDecision } from './tool-review';

interface Props {
  connection: Connection;
  tools: Tool[];
  agents: AgentLite[];
  canManage: boolean;
  closeHref: string;
  /** Server-rendered health history. */
  health: ReactNode;
}

function agentsText(c: Connection, agents: AgentLite[]): string {
  if (c.kind === 'TEMPLATE') return 'none — user-scoped';
  if (c.allowedAgentIds === '*') return 'any agent a Lead enables';
  if (!c.allowedAgentIds.length) return 'none yet';
  return c.allowedAgentIds.map((id) => agents.find((a) => a.id === id)?.name ?? 'unknown agent').join(', ');
}

/** An approved MCP connection: status, tools (drift and removals included), health history and lifecycle actions. */
export function ConnectionDrawer({ connection: c, tools, agents, canManage, closeHref, health }: Props) {
  const close = useCloseTo(closeHref);
  const [overrides, setOverrides] = useState<Record<string, ToolDecision>>({});
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const decisions = { ...initialDecisions(tools), ...overrides };
  const status = connectionStatus(c);
  const info = serverInfoSummary(c.serverInfo);
  const disabled = c.status === 'DISABLED';

  function act(task: () => Promise<{ ok: true; text: string } | { ok: false; text: string }>) {
    setMessage(null);
    start(async () => {
      const r = await task();
      setMessage({ tone: r.ok ? 'info' : 'error', text: r.text });
    });
  }

  const rediscover = () =>
    act(async () => {
      const r = await rediscoverAction(c.id);
      return r.ok ? { ok: true, text: r.data.message } : { ok: false, text: r.message };
    });
  const check = () =>
    act(async () => {
      const r = await checkHealthAction(c.id, 'connections');
      return r.ok ? { ok: true, text: `Health: ${r.data.health.toLowerCase()} · ${formatLatency(r.data.latencyMs)} · ${r.data.detail}` } : { ok: false, text: r.message };
    });
  const save = () =>
    act(async () => {
      const live = new Set(tools.filter((t) => !t.removedAt).map((t) => t.id));
      const list = Object.entries(decisions)
        .filter(([id]) => live.has(id))
        .map(([toolId, d]) => ({ toolId, ...d }));
      const r = await classifyToolsAction(c.id, list);
      if (r.ok) setOverrides({});
      return r.ok ? { ok: true, text: `Saved · ${r.data.approved} tools approved` } : { ok: false, text: r.message };
    });

  return (
    <Drawer title={c.name} sub={c.url} onClose={close} footer={<span className="mono-sm">every change here is audited and attributed to you</span>}>
      <div role="status" aria-live="polite">
        {message ? (
          <AlertBanner tone={message.tone} style={{ margin: 0 }}>
            {message.text}
          </AlertBanner>
        ) : null}
      </div>
      {c.status === 'AUTH_REQUIRED' ? (
        <AlertBanner tone="warn" style={{ margin: 0 }} title="The server rejects the stored credential." action={canManage ? <Link className="btn tiny" href={connectionsHref({ tab: 'mcp', connection: c.id, step: 'auth' })} scroll={false}>Re-authenticate</Link> : null}>
          Tools on this connection are unavailable to agents until it is re-authenticated.
        </AlertBanner>
      ) : null}
      {c.tools.changed ? (
        <AlertBanner tone="warn" style={{ margin: 0 }} title={`${c.tools.changed} tool${c.tools.changed === 1 ? '' : 's'} changed since approval.`}>
          Changed descriptions or schemas are withheld from agents until re-approved below.
        </AlertBanner>
      ) : null}
      <div className="rowsplit">
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
        <span className="mono-sm">{`${scopeLabel(c.kind)} · ${c.network.toLowerCase()} · ${authLabel(c.auth)}`}</span>
      </div>
      <KeyValue
        template="minmax(90px,110px) minmax(0,1fr)"
        fontSize={12}
        items={[
          { k: 'server', v: `${info.name ?? 'unnamed'}${info.version ? ` · v${info.version}` : ''} · ${c.protocolVersion ?? 'protocol unknown'}` },
          { k: 'tools', v: `${c.tools.approved} approved of ${c.tools.total}` },
          { k: 'agents', v: agentsText(c, agents) },
          { k: 'confirmation', v: CONFIRMATION_LABEL[c.confirmationPolicy] },
          { k: 'claims', v: c.sendCustomerClaims ? 'signed customer claims sent' : 'not sent' },
          { k: 'health', v: c.health.checkedAt ? `${c.health.status?.toLowerCase() ?? '—'} · ${formatLatency(c.health.latencyMs)} · ${formatAge(c.health.checkedAt)} ago · every ${c.healthCheckSeconds}s` : `every ${c.healthCheckSeconds}s · no check yet` },
          { k: 'last sync', v: c.lastSyncAt ? `${formatAge(c.lastSyncAt)} ago` : 'never' },
          { k: 'credential', v: c.auth.strategy === 'NONE' ? 'none' : `stored by reference${c.auth.scopes.length ? ` · scopes ${c.auth.scopes.join(' ')}` : ''}` },
          ...(c.lastError ? [{ k: 'last error', v: c.lastError }] : []),
        ]}
      />
      {canManage ? (
        <div className="rowsplit">
          <button type="button" className="btn tiny" onClick={rediscover} disabled={pending || disabled}>
            Re-discover tools
          </button>
          <button type="button" className="btn tiny" onClick={check} disabled={pending || disabled || c.kind !== 'SHARED'}>
            Check health
          </button>
          <Link className="btn tiny ghost" href={connectionsHref({ tab: 'mcp', connection: c.id, step: 'auth' })} scroll={false}>
            Authentication
          </Link>
          <Link className="btn tiny ghost" href={connectionsHref({ tab: 'mcp', connection: c.id, step: 'approve' })} scroll={false}>
            Edit approval
          </Link>
        </div>
      ) : null}
      <section aria-label="Tools" style={{ display: 'grid', gap: 8 }}>
        <span className="grp">Tools</span>
        <ToolReview tools={tools} decisions={decisions} onChange={(id, d) => setOverrides((p) => ({ ...p, [id]: d }))} readOnly={!canManage} />
        {canManage ? (
          <div>
            <button type="button" className="btn tiny accent" onClick={save} disabled={pending || !Object.keys(overrides).length}>
              Save tool classification
            </button>
          </div>
        ) : null}
      </section>
      <section aria-label="Health history" style={{ display: 'grid', gap: 8 }}>
        <span className="grp">Health history</span>
        {health}
      </section>
      {canManage ? (
        <div className="rowsplit">
          {disabled ? (
            <button type="button" className="btn tiny" disabled={pending} onClick={() => act(async () => {
              const r = await setConnectionEnabledAction(c.id, true);
              return r.ok ? { ok: true, text: `Enabled · status ${r.data.status.toLowerCase()}` } : { ok: false, text: r.message };
            })}>
              Enable
            </button>
          ) : (
            <ConfirmAction label="Disable" buttonClass="btn tiny" title={`Disable ${c.name}`} confirmLabel="Disable connection" run={() => setConnectionEnabledAction(c.id, false)}>
              {`Agents and people lose access to its ${c.tools.approved} tools immediately; health checks stop. Credentials are kept, so you can enable it again.`}
            </ConfirmAction>
          )}
          <span className="sp" />
          <ConfirmAction label="Delete" title={`Delete ${c.name}`} confirmLabel="Delete connection" typeToConfirm={c.name} run={() => deleteConnectionAction(c.id, 'connections')} onDone={close}>
            {c.kind === 'TEMPLATE'
              ? 'The template and every user’s personal connection to it are deleted, and all their stored credentials are revoked.'
              : 'The connection, its tools and agent grants are deleted and its stored credentials are revoked. This cannot be undone.'}
          </ConfirmAction>
        </div>
      ) : null}
    </Drawer>
  );
}
