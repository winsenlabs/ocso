'use client';

import { useState } from 'react';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { CopyButton } from '../copy-button';
import { embedTabsFor, scriptHint, type EmbedTab, type EmbedTarget } from './embed-snippets';

const HINTS: Readonly<Record<Exclude<EmbedTab, 'script'>, string>> = {
  react: 'Build your own chat UI in React with the SDK (themable with CSS variables).',
  native: 'React Native apps send no Origin: use client mode with a session pass, or allow native apps.',
  server: 'Your backend mints a single-use session pass with the secret key and hands it to the browser or app.',
};

/**
 * How to put an embeddable channel on a site or in an app: the publishable key, then one tab per way in
 * (script tag, React, React Native, and the backend call that mints session passes). The secret key is
 * never shown here; the Server tab reads it from the backend's environment.
 */
export function EmbedPanel({ target, idBase = 'embed' }: { target: EmbedTarget; idBase?: string }) {
  const tabs = embedTabsFor(target.authMode);
  const [picked, setTab] = useState<EmbedTab>(tabs[0]!.id);
  // The auth mode can change while the panel is open (e.g. after an edit): fall back to its first tab.
  const current = tabs.find((t) => t.id === picked) ?? tabs[0]!;
  const tab = current.id;
  const snippet = current.build(target);
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="rowsplit" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
        <span className="mono-sm">Publishable key</span>
        <code className="secret-once" aria-label="Publishable key">
          {target.publishableKey}
        </code>
        <CopyButton value={target.publishableKey} what="publishable key" />
      </div>
      <Tabs items={tabs.map((t) => ({ key: t.id, label: t.label }))} active={tab} onSelect={(k) => setTab(k as EmbedTab)} label="How to embed" idBase={idBase} />
      <TabPanel idBase={idBase} active={tab}>
        <p style={{ margin: '0 0 6px', fontSize: 12.5 }}>{tab === 'script' ? scriptHint(target.authMode) : HINTS[tab]}</p>
        <div className="rowsplit" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          {tab === 'script' ? (
            <code className="secret-once" aria-label="Embed snippet">
              {snippet}
            </code>
          ) : (
            <pre className="secret-once" aria-label={`${current.label} snippet`} style={{ margin: 0, whiteSpace: 'pre', overflowX: 'auto', maxWidth: '100%' }}>
              <code>{snippet}</code>
            </pre>
          )}
          <CopyButton value={snippet} what={tab === 'script' ? 'embed snippet' : `${current.label} snippet`} />
        </div>
      </TabPanel>
    </div>
  );
}
