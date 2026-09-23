import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConversationSkeleton, ConversationView } from '@/components/workspace/conversation-view';

export const metadata: Metadata = { title: 'Conversation' };

/** One conversation in the workspace (design/01 centre + customer rail). */
export default function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<ConversationSkeleton />}>
      <ConversationView params={params} />
    </Suspense>
  );
}
