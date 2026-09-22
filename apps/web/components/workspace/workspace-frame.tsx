import { Permission } from '@ocso/auth';
import { EmptyState } from '@/components/ui/empty-state';
import { loadAgentOptions, loadQueueOptions, type Option } from '@/lib/api/conversations';
import { hasPermission, requireSession } from '@/lib/session';
import { InboxClient, InboxSkeletonRows } from './inbox-client';

/**
 * Inbox pane of the workspace (design/01 left). Roles without conversation
 * access (Platform Tech Admin) get a clean forbidden state instead, which
 * spans the workspace and hides the other panes (workspace.css) — the API
 * would answer 403 for every call.
 */
export async function InboxPane() {
  const session = await requireSession();
  if (!hasPermission(session, Permission.CONVERSATIONS_READ)) return <WorkspaceForbidden role={session.roleLabel} />;

  const [agents, queues] = await Promise.all([
    hasPermission(session, Permission.AGENTS_READ) ? loadAgentOptions().catch(() => [] as Option[]) : Promise.resolve([] as Option[]),
    hasPermission(session, Permission.QUEUES_READ) ? loadQueueOptions().catch(() => [] as Option[]) : Promise.resolve([] as Option[]),
  ]);
  const defaultView = hasPermission(session, Permission.CONVERSATIONS_READ_ALL) ? 'all' : 'mine';
  return <InboxClient defaultView={defaultView} agents={agents} queues={queues} meId={session.user.id} timeZone={session.user.deployment.timezone} />;
}

export function WorkspaceForbidden({ role }: { role: string }) {
  return (
    <div className="ws-forbidden">
      <div className="page-head">
        <h1>Conversations</h1>
        <p className="page-sub">Customer conversations and who is in control of each.</p>
      </div>
      <EmptyState title="Conversation content is not available for your role">
        {role} accounts do not see customer conversations. Technical debugging uses traces, usage and turn metadata, which never include
        transcript text. Ask a CS Lead if you need a conversation reviewed.
      </EmptyState>
    </div>
  );
}

export function InboxFallback() {
  return (
    <section className="inbox" aria-label="Inbox" aria-busy="true">
      <div className="ih page-head">
        <h1>Conversations</h1>
      </div>
      <div className="filters" />
      <div className="list">
        <InboxSkeletonRows />
      </div>
    </section>
  );
}
