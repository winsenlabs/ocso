/**
 * Copy-paste snippets for an embeddable channel (SPEC §C.7): the script tag
 * (OCSO's hosted widget), the React and React Native SDKs, and the backend
 * call that mints a session pass with the channel's secret key. Pure strings,
 * unit-tested; the secret key itself never appears (only an env reference).
 */

export type EmbedTab = 'script' | 'react' | 'native' | 'server';

export interface EmbedTarget {
  /** OCSO's public origin (the API base the SDKs call). */
  origin: string;
  /** The channel's publishable key (`publicKey`). */
  publishableKey: string;
  /** anonymous | client | user: whether the client must fetch a session pass first. */
  authMode: string;
}

const base = (origin: string) => origin.replace(/\/+$/, '');
const needsPass = (mode: string) => mode === 'client' || mode === 'user';

export function scriptSnippet(t: EmbedTarget): string {
  return `<script src="${base(t.origin)}/ocso-webchat.js" data-key="${t.publishableKey}" async></script>`;
}

export function reactSnippet(t: EmbedTarget): string {
  const pass = needsPass(t.authMode)
    ? `\n        // ${t.authMode} mode: every session starts with a pass your backend mints (see the Server tab).\n        getSessionPass: () => fetch('/api/ocso/session-pass', { method: 'POST' }).then((r) => r.json()).then((b) => b.sessionPass),`
    : '';
  return `// npm i @winsendotai/ocso-chat @winsendotai/ocso-chat-react
import { OcsoChat } from '@winsendotai/ocso-chat-react';
import '@winsendotai/ocso-chat-react/styles.css';

export function SupportChat() {
  return (
    <OcsoChat
      options={{
        baseUrl: '${base(t.origin)}',
        publishableKey: '${t.publishableKey}',${pass}
      }}
    />
  );
}`;
}

export function nativeSnippet(t: EmbedTarget): string {
  const pass = needsPass(t.authMode)
    ? `\n        getSessionPass: () => fetch('https://your-backend.example.com/ocso/session-pass', { method: 'POST' }).then((r) => r.json()).then((b) => b.sessionPass),`
    : `\n        // Anonymous mode: turn on "Allow native apps" (apps send no Origin), or use client mode with a session pass.`;
  return `// npm i @winsendotai/ocso-chat @winsendotai/ocso-chat-react
import { OcsoChatView } from '@winsendotai/ocso-chat-react/native';

export function SupportScreen() {
  return (
    <OcsoChatView
      options={{
        baseUrl: '${base(t.origin)}',
        publishableKey: '${t.publishableKey}',${pass}
      }}
    />
  );
}`;
}

export function serverSnippet(t: EmbedTarget): string {
  return `// Your backend (Node 20+). The secret key (sk_…) stays here: never ship it in a page or an app.
export async function mintSessionPass({ userToken, context } = {}) {
  const res = await fetch('${base(t.origin)}/public/webchat/${t.publishableKey}/session-pass', {
    method: 'POST',
    headers: { authorization: \`Bearer \${process.env.OCSO_SECRET_KEY}\`, 'content-type': 'application/json' },
    // userToken: the signed-in user's token (verified by OCSO); context: allowlisted keys, e.g. { plan: 'gold' }
    body: JSON.stringify({ userToken, context, ttlSeconds: 600 }),
  });
  if (!res.ok) throw new Error(\`OCSO session pass: \${res.status}\`);
  const { sessionPass, expiresAt } = await res.json();
  return { sessionPass, expiresAt }; // single use; hand it to the browser or app
}`;
}

export const EMBED_TABS: ReadonlyArray<{ id: EmbedTab; label: string; build: (t: EmbedTarget) => string }> = [
  { id: 'script', label: 'Script tag', build: scriptSnippet },
  { id: 'react', label: 'React', build: reactSnippet },
  { id: 'native', label: 'React Native', build: nativeSnippet },
  { id: 'server', label: 'Server', build: serverSnippet },
];

/**
 * The ways in that work for an auth mode. The hosted widget (script tag) cannot fetch session passes, so in
 * client mode it would get `session_pass_required` on every open: the tab is left out and the SDKs come first.
 * In user mode it works once the page calls `OcsoWebChat.identify(userToken)` (see `scriptHint`).
 */
export function embedTabsFor(authMode: string): typeof EMBED_TABS {
  return authMode === 'client' ? EMBED_TABS.filter((t) => t.id !== 'script') : EMBED_TABS;
}

/** What the script tag needs in this auth mode. */
export function scriptHint(authMode: string): string {
  if (authMode === 'user') {
    return 'Add this tag to every page that should show the chat launcher (OCSO’s hosted widget). User mode: the chat opens only after the page calls OcsoWebChat.identify(userToken) for the signed-in user.';
  }
  return 'Add this tag to every page that should show the chat launcher (OCSO’s hosted widget).';
}
