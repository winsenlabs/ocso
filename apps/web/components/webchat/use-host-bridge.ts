'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createHostBridge, resolveHostOrigin, type HostBridge, type HostCommand, type WidgetEvent } from '@/lib/webchat/bridge';
import type { WebChatConfig } from '@/lib/webchat/types';

/**
 * Embedding state of the widget page:
 * - standalone (opened directly): always open, no bridge;
 * - framed by the loader (`?embed=1`): the host opens/closes the panel and may
 *   identify the customer; the widget reports readiness, unread count and
 *   close requests — only to/from the verified host origin (lib/webchat/bridge);
 * - framed by a site outside the channel's allowlist: blocked.
 */

export type Embedding = 'pending' | 'standalone' | 'managed' | 'framed' | 'blocked';

export interface HostBridgeOptions {
  config: WebChatConfig;
  onCommand: (command: HostCommand) => void;
}

export function useHostBridge({ config, onCommand }: HostBridgeOptions) {
  const [embedding, setEmbedding] = useState<Embedding>('pending');
  const [open, setOpen] = useState(false);
  const bridge = useRef<HostBridge | null>(null);
  const handler = useRef(onCommand);
  handler.current = onCommand;

  useEffect(() => {
    const framed = window.parent !== window;
    const params = new URLSearchParams(window.location.search);
    const resolved = resolveHostOrigin({
      framed,
      hostParam: params.get('host'),
      ancestorOrigins: window.location.ancestorOrigins ? Array.from(window.location.ancestorOrigins) : null,
      referrer: document.referrer,
      allowedOrigins: config.allowedOrigins,
    });
    if (!resolved.ok) {
      const blocked = resolved.reason === 'not_allowed' || resolved.reason === 'mismatch';
      setEmbedding(blocked ? 'blocked' : framed ? 'framed' : 'standalone');
      setOpen(!blocked);
      return;
    }
    const managed = params.get('embed') === '1';
    const b = createHostBridge(window, resolved.origin, (command) => {
      if (command.type === 'open') setOpen(true);
      if (command.type === 'close') setOpen(false);
      handler.current(command);
    });
    bridge.current = b;
    setEmbedding(managed ? 'managed' : 'framed');
    setOpen(!managed);
    const title = config.branding.title ?? config.assistantName ?? config.name;
    b.post({
      type: 'ready',
      branding: { accentColor: config.branding.accentColor ?? null, position: config.branding.position, launcherLabel: config.branding.launcherLabel ?? null, title },
    });
    return () => {
      b.dispose();
      bridge.current = null;
    };
  }, [config]);

  const post = useCallback((event: WidgetEvent) => bridge.current?.post(event), []);

  /** The customer closed the panel from inside the widget. */
  const requestClose = useCallback(() => {
    if (!bridge.current) return;
    setOpen(false);
    bridge.current.post({ type: 'close' });
  }, []);

  return { embedding, open, post, requestClose };
}
