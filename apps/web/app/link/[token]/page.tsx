import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { ConfirmChatLink } from '@/components/chat-links/confirm-chat-link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { previewChatLink } from '@/lib/api/chat-links';
import { describeApiError } from '@/lib/api/errors';
import { getSession, mfaPending } from '@/lib/session';
import '../../styles/auth.css';

export const metadata: Metadata = { title: 'Link chat account' };

type Params = Promise<{ token: string }>;

/**
 * `/link/<token>`: the one-time link Ask OCSO sends an unknown sender in Slack or Teams. Signed in (the proxy and
 * this page send anyone else to sign-in and back), the user sees which chat account on which channel would be
 * linked to their OCSO account (with its full id: Slack workspace and user, Teams tenant and user), and confirms;
 * the page then shows a code they send from that chat account to finish (proof the chat account is theirs). Refused when the link expired or was used, when the user may not use
 * Ask OCSO, or when the chat account is linked to someone else.
 */
export default function LinkChatAccountPage({ params }: { params: Params }) {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <LinkContent params={params} />
      </Suspense>
    </main>
  );
}

const STATE_TEXT: Record<'expired' | 'used' | 'invalid', { title: string; body: string }> = {
  expired: { title: 'This link expired.', body: 'Links last 10 minutes. Send the app a new message in the chat to get a fresh one.' },
  used: { title: 'This link was already used.', body: 'Each link works once. If your chat account is not linked yet, send the app a new message to get a fresh one.' },
  invalid: { title: 'This link is not valid.', body: 'Open the link from the chat again, or send the app a new message to get a fresh one.' },
};

async function LinkContent({ params }: { params: Params }) {
  const { token } = await params;
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(`/link/${token}`)}`);
  if (mfaPending(session)) redirect('/mfa-setup');
  let preview;
  try {
    preview = await previewChatLink(token);
  } catch (err) {
    return (
      <AuthCard title="Link chat account">
        <AlertBanner tone="error" title="This link could not be checked.">
          {describeApiError(err)}
        </AlertBanner>
      </AuthCard>
    );
  }
  const you = preview.you ? `${preview.you.name} (${preview.you.email})` : session.user.name;
  if (preview.state !== 'valid' || !preview.channel) {
    const text = STATE_TEXT[preview.state === 'valid' ? 'invalid' : preview.state];
    return (
      <AuthCard title="Link chat account" foot={<a href="/">Go to OCSO</a>}>
        <AlertBanner tone="warn" title={text.title}>
          {text.body}
        </AlertBanner>
      </AuthCard>
    );
  }
  const network = preview.network ?? 'chat';
  const who = preview.profileName ? `${preview.profileName} · ${preview.identity}` : preview.identity;
  return (
    <AuthCard title={`Link your ${network} account`} sub="Ask OCSO in chat, as yourself." foot={<span>only confirm a link you just asked for in the chat, from your own account</span>}>
      <dl className="link-facts" aria-label="What will be linked">
        <dt>{network} account</dt>
        <dd>{who}</dd>
        {preview.account ? (
          <>
            <dt>Account id</dt>
            <dd>{preview.account}</dd>
          </>
        ) : null}
        <dt>Channel</dt>
        <dd>{preview.channel.name}</dd>
        <dt>Your OCSO account</dt>
        <dd>{you}</dd>
      </dl>
      {preview.refusal ? (
        <AlertBanner tone="error" title="You cannot link this account.">
          {preview.refusal}
        </AlertBanner>
      ) : (
        <>
          <p className="auth-sub">
            {preview.alreadyLinked
              ? 'This chat account is already linked to you. Confirm to keep using it.'
              : `Link ${who} to ${you}? Ask OCSO will answer that chat account with your own permissions; every change still waits for a click there, and approvals work as in OCSO. After you confirm, you send a short code from that chat account to prove it is yours. You can revoke the link on your Account page at any time.`}
          </p>
          <ConfirmChatLink token={token} network={network} />
        </>
      )}
    </AuthCard>
  );
}
