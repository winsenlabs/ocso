import { notFound } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { EmptyState } from '@/components/ui/empty-state';
import {
  loadConversation,
  loadConversationTools,
  loadCopilotLatest,
  loadCustomer,
  loadQueueOptions,
  loadTimeline,
  loadTransferUsers,
  type CopilotState,
  type Option,
} from '@/lib/api/conversations';
import { ApiError } from '@/lib/api/errors';
import { hasPermission, requireSession } from '@/lib/session';
import { ConversationClient } from './conversation-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COPILOT_STATES = new Set(['WAITING_FOR_HUMAN', 'HUMAN_ACTIVE']);
const none = <T,>(): Promise<T[]> => Promise.resolve([]);

/** Loads everything the conversation pane and rail show, from the real API only. */
export async function ConversationView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  // No conversation access: the inbox pane shows the forbidden state for the whole workspace.
  if (!hasPermission(session, Permission.CONVERSATIONS_READ)) return null;
  const can = (p: Permission) => hasPermission(session, p);

  let core;
  try {
    core = await Promise.all([loadConversation(id), loadTimeline(id), loadConversationTools(id)]);
  } catch (err) {
    if (err instanceof ApiError && (err.isForbidden || err.status === 404)) return <ConversationUnavailable />;
    throw err;
  }
  const [detail, timeline, tools] = core;

  const [customer, copilot, transferQueues, transferUsers] = await Promise.all([
    can(Permission.CUSTOMERS_READ) ? loadCustomer(detail.customer.id).catch(() => null) : Promise.resolve(null),
    can(Permission.COPILOT_USE) && COPILOT_STATES.has(detail.controlState)
      ? loadCopilotLatest(id).catch((): CopilotState => ({ status: 'unavailable' }))
      : Promise.resolve<CopilotState>({ status: 'unavailable' }),
    can(Permission.CONVERSATIONS_TRANSFER) && can(Permission.QUEUES_READ) ? loadQueueOptions().catch(() => [] as Option[]) : none<Option>(),
    can(Permission.CONVERSATIONS_ASSIGN) && can(Permission.USERS_READ) ? loadTransferUsers().catch(() => [] as Option[]) : none<Option>(),
  ]);

  return (
    <ConversationClient
      key={detail.id}
      me={{ id: session.user.id, name: session.user.name }}
      permissions={[...session.permissions]}
      timeZone={session.user.deployment.timezone}
      renderedAt={Date.now()}
      detail={detail}
      timeline={timeline}
      tools={tools}
      customer={customer}
      copilot={copilot}
      transferQueues={transferQueues}
      transferUsers={transferUsers.filter((u) => u.id !== session.user.id)}
    />
  );
}

function ConversationUnavailable() {
  return (
    <section className="center span" aria-label="Conversation">
      <div className="ws-empty">
        <EmptyState title="This conversation is not available to you">
          It may not exist, or it is outside the queues and assignments your role can see. Pick another conversation from the inbox.
        </EmptyState>
      </div>
    </section>
  );
}

export function ConversationSkeleton() {
  return (
    <section className="center span" aria-busy="true" aria-label="Conversation">
      <div className="ws-empty">
        <span className="mono-sm">Loading conversation…</span>
      </div>
    </section>
  );
}
