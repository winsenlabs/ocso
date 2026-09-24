'use client';

import { useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { confirmChatLinkAction, type ChatLinkResult } from '@/lib/actions/chat-links';

/**
 * The link page's Confirm: claims the link and shows the code the user sends from their own chat account to finish
 * (the proof they hold that chat account). A chat account already linked to them is simply kept.
 */
export function ConfirmChatLink({ token, network }: { token: string; network: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ChatLinkResult | null>(null);
  if (result?.ok && result.code) {
    return (
      <div aria-live="polite">
        <p className="auth-sub">Last step: send this code to the app in {network}, from your own account, where you asked for the link.</p>
        <p className="link-code" data-testid="link-code">
          {result.code}
        </p>
        <AlertBanner tone="warn" title="Never give this code to anyone.">
          Whoever sends it from their chat account can ask Ask OCSO as you. It works once, for 10 minutes.
        </AlertBanner>
      </div>
    );
  }
  if (result?.ok) {
    return (
      <AlertBanner title="Linked." action={<a href="/account/security">Your links</a>}>
        {result.message}
      </AlertBanner>
    );
  }
  return (
    <>
      {result ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {result.message}
        </AlertBanner>
      ) : null}
      <button className="btn accent" type="button" disabled={pending} onClick={() => start(async () => setResult(await confirmChatLinkAction(token)))}>
        {pending ? 'Linking…' : 'Confirm link'}
      </button>
    </>
  );
}
