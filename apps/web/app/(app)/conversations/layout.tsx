import { Suspense, type ReactNode } from 'react';
import { InboxFallback, InboxPane } from '@/components/workspace/workspace-frame';
import '../../styles/workspace.css';
import '../../styles/templates.css';

/**
 * CS workspace (design/01): inbox · conversation · customer rail. The inbox
 * streams in beside the route's panes (it persists across conversations);
 * the page segment is never held behind it.
 */
export default function ConversationsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="ws">
      <Suspense fallback={<InboxFallback />}>
        <InboxPane />
      </Suspense>
      {children}
    </div>
  );
}
