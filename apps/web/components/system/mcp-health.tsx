import Link from 'next/link';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import type { McpTelemetry } from '@/lib/api/telemetry';
import { formatLatency, formatPercent } from '@/lib/format';
import { mcpChip } from './system-meta';

const AUTH: Record<string, string> = { NONE: 'none', HEADER: 'header', OAUTH: 'OAuth 2.1' };

/** MCP and tool connection health (design/03 .dt-mcp): organization connections, tools, 24 h p95 and failure rate. */
export function McpHealthTable({ data, manageHref }: { data: McpTelemetry; manageHref: string | null }) {
  const rows = data.connections;
  const tools = rows.reduce((sum, c) => sum + c.tools, 0);
  return (
    <>
      <SecHead
        id="mcp"
        title="MCP and tool connection health"
        count={`${rows.length} server${rows.length === 1 ? '' : 's'} · ${tools} tools${data.personalConnections ? ` · ${data.personalConnections} personal` : ''}`}
        actions={
          manageHref ? (
            <Link className="btn tiny ghost" href={manageHref}>
              MCP connections
            </Link>
          ) : null
        }
      />
      <DataTable
        label="MCP connections"
        template="minmax(0,1.1fr) minmax(0,1.3fr) 92px 92px 66px 84px 110px"
        rows={rows}
        rowKey={(c) => c.connectionId}
        empty={<EmptyState title="No MCP connection yet">Shared and user-scoped tool servers appear here with their health once added under Integrations → MCP connections.</EmptyState>}
        columns={[
          {
            key: 'name',
            header: 'Connection',
            cell: (c) => (
              <>
                <b style={{ fontSize: 12.5 }}>{c.name}</b>
                {c.description ? (
                  <span className="mono-sm" style={{ display: 'block' }}>
                    {c.description}
                  </span>
                ) : null}
              </>
            ),
          },
          { key: 'server', header: 'Server', cell: (c) => <span className="mono-sm">{c.server}</span> },
          { key: 'auth', header: 'Auth', cell: (c) => <span className="mono-sm">{AUTH[c.authStrategy] ?? c.authStrategy.toLowerCase()}</span> },
          { key: 'scope', header: 'Scope', cell: (c) => <span className="mono-sm">{c.scope === 'USER' ? 'user-scoped' : 'shared'}</span> },
          { key: 'tools', header: 'Tools', cell: (c) => <span className="mono">{c.tools}</span> },
          {
            key: 'p95',
            header: 'p95',
            cell: (c) => (
              <span className="mono" title={c.calls24h ? `${c.calls24h} calls · ${formatPercent(c.failureRate24h)} failed (24 h)` : 'no calls in 24 h'}>
                {formatLatency(c.p95LatencyMs)}
              </span>
            ),
          },
          {
            key: 'health',
            header: 'Health',
            cell: (c) => {
              const chip = mcpChip(c.status);
              return (
                <StatusChip tone={chip.tone} {...(c.lastError ? { title: c.lastError } : {})}>
                  {chip.label}
                </StatusChip>
              );
            },
          },
        ]}
      />
    </>
  );
}
