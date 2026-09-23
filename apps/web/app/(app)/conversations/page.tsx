import type { Metadata } from 'next';
import { EmptyState } from '@/components/ui/empty-state';

export const metadata: Metadata = { title: 'Conversations' };

/** Workspace with nothing selected: the inbox (layout) plus a prompt to pick a conversation. */
export default function ConversationsPage() {
  return (
    <section className="center span" aria-label="Conversation">
      <div className="ws-empty">
        <EmptyState title="Select a conversation">
          Pick a conversation from the inbox to see its full timeline — customer, AI and human turns, tool actions and internal notes — and
          the customer’s context. Waiting-for-human conversations can be claimed from there.
        </EmptyState>
      </div>
    </section>
  );
}
