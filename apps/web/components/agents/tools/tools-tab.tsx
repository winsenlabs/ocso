import Link from 'next/link';
import { PendingBadge } from '@/components/approvals/pending-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { objectApprovalState } from '@/lib/api/approvals';
import { SecHead } from '@/components/ui/sec-head';
import type { AgentPageData } from '../detail/load';
import { ToolGrantsEditor } from './tool-grants-editor';

/**
 * Tools tab (design/02): approved MCP tools this agent may call. The
 * mockup's per-tool volume, failure rate and p95 columns are omitted: no
 * per-agent tool metrics endpoint exists for business roles.
 */
export async function ToolsTab({ data }: { data: AgentPageData }) {
  const { agent, tools, can } = data;
  if (tools === null) {
    return <EmptyState title="Tools are not available for your role">A Lead manages which approved tools this agent may call.</EmptyState>;
  }
  // Maker–checker (PM/research/11 §4): once the agent is approved, widening its tools waits for a checker.
  const approval = await objectApprovalState('agent_tool_grant', agent.id).catch(() => null);
  const enabled = tools.filter((t) => t.grant?.enabled).length;
  return (
    <>
      <SecHead
        title="Enabled tools"
        count={`${enabled} of ${tools.filter((t) => t.eligible).length} approved`}
        desc="resolved at runtime from these grants, shared connections and the acting user's scope"
        actions={<PendingBadge state={approval} />}
      />
      {tools.length === 0 ? (
        <EmptyState
          title="No approved tools for this agent"
          actions={
            can.providers ? (
              <Link className="btn" href="/connections?tab=mcp">
                MCP connections
              </Link>
            ) : undefined
          }
        >
          Tools come from shared MCP connections a Tech admin has approved and opened to this agent. Once there are some, enable them here.
        </EmptyState>
      ) : (
        <ToolGrantsEditor
          key={JSON.stringify(tools.map((t) => [t.toolId, t.grant]))}
          agentId={agent.id}
          agentName={agent.name}
          tools={tools}
          canEdit={can.tools}
          governed={Boolean(approval?.updateNeedsApproval || agent.approval?.approved)}
          pending={Boolean(approval?.pending)}
        />
      )}
    </>
  );
}
