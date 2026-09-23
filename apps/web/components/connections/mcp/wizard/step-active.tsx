'use client';

import Link from 'next/link';
import { useState } from 'react';
import { KeyValue } from '@/components/ui/key-value';
import { StatusChip } from '@/components/ui/status-chip';
import { checkHealthAction } from '@/lib/actions/mcp';
import type { Connection, Tool } from '@/lib/api/mcp';
import { formatLatency } from '@/lib/format';
import { connectionsHref } from '../../url';
import { connectionStatus, scopeLabel, serverInfoSummary } from '../meta';
import { STEP_FORM, type StepApi } from './step-api';

/** Step 6 "Active": the approved connection, its first health check and where to go next. */
export function StepActive({ connection, tools, api }: { connection: Connection | null; tools: Tool[]; api: StepApi }) {
  const [health, setHealth] = useState<string | null>(null);
  if (!connection) return <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.close())} />;
  const info = serverInfoSummary(connection.serverInfo);
  const live = tools.filter((t) => !t.removedAt);
  const approved = live.filter((t) => t.approved).length;
  const status = connectionStatus(connection);
  const active = connection.approvedAt !== null;
  const id = connection.id;

  function check() {
    api.run(async () => {
      const r = await checkHealthAction(id, 'connections');
      if (!r.ok) api.fail(r.message);
      else setHealth(`${r.data.health.toLowerCase().replace(/_/g, ' ')} · ${formatLatency(r.data.latencyMs)}${r.data.health === 'HEALTHY' ? '' : ` · ${r.data.detail}`}`);
    });
  }

  return (
    <form id={STEP_FORM} onSubmit={(e) => (e.preventDefault(), api.close())} style={{ display: 'grid', gap: 12 }}>
      <div className="empty conn-success">
        <h3>{active ? `${connection.name} is ${connection.kind === 'TEMPLATE' ? 'published' : 'active'}` : `${connection.name} is not approved yet`}</h3>
        <p>
          {connection.kind === 'TEMPLATE'
            ? `Users can now connect their own accounts to it from My connections; ${approved} approved tools carry over to their copies.`
            : `Health checks run every ${connection.healthCheckSeconds}s and the ${approved} approved tools are available to the agents it allows. Every call is audited.`}
        </p>
      </div>
      <KeyValue
        items={[
          { k: 'connection', v: `${connection.name} · ${scopeLabel(connection.kind)}` },
          { k: 'server', v: <span className="mono-sm">{`${connection.url}${info.version ? ` · v${info.version}` : ''}`}</span> },
          { k: 'tools', v: `${approved} enabled · ${live.length - approved} held back` },
          { k: 'status', v: <StatusChip tone={status.tone}>{status.label}</StatusChip> },
          { k: 'health', v: health ?? (connection.health.checkedAt ? `${connection.health.status?.toLowerCase() ?? 'unknown'} · ${formatLatency(connection.health.latencyMs)}` : 'first check pending') },
        ]}
      />
      <div className="rowsplit">
        {connection.kind === 'SHARED' ? (
          <button type="button" className="btn tiny" onClick={check} disabled={api.pending}>
            Run health check now
          </button>
        ) : null}
        <Link className="btn tiny ghost" href={connectionsHref({ tab: 'mcp', connection: id })} scroll={false}>
          Open connection details
        </Link>
        <Link className="btn tiny ghost" href="/audit">
          View in audit log
        </Link>
      </div>
    </form>
  );
}
