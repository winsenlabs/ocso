import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ChatUnavailable } from '@/components/webchat/chat-unavailable';
import { WebChatApp } from '@/components/webchat/webchat-app';
import { loadWidgetConfig } from '@/lib/webchat/config.server';

export const metadata: Metadata = { title: { absolute: 'Chat' }, robots: { index: false, follow: false } };

type Params = Promise<{ publicKey: string }>;

/**
 * Customer web chat page — rendered inside the embed iframe (public/ocso-webchat.js)
 * or opened directly. Public: authenticated only by the visitor token the widget
 * obtains from the channel (proxy.ts exempts /chat from the staff session gate).
 */
export default function ChatPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ChatLoading />}>
      <ChatLoader params={params} />
    </Suspense>
  );
}

async function ChatLoader({ params }: { params: Params }) {
  const { publicKey } = await params;
  const config = await loadWidgetConfig(publicKey);
  if (!config) return <ChatUnavailable />;
  return <WebChatApp publicKey={publicKey} config={config} />;
}

function ChatLoading() {
  return (
    <div className="wc" aria-busy="true">
      <div className="wc-center">
        <div className="wc-skel" />
        <div className="wc-skel" style={{ width: '40%' }} />
      </div>
    </div>
  );
}
