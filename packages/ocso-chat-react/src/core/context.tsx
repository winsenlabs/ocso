'use client';

import { createOcsoChat, type OcsoChatClient, type OcsoChatOptions } from '@winsendotai/ocso-chat';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Shared by the web and React Native entries: no DOM (or react-dom) imports here.
 */

const OcsoChatContext = createContext<OcsoChatClient | null>(null);

export type OcsoChatProviderProps = {
  children?: ReactNode;
  /** Connect as soon as the provider mounts (default true). Otherwise call `connect()` (e.g. when the panel opens). */
  autoConnect?: boolean;
} & ({ client: OcsoChatClient; options?: never } | { options: OcsoChatOptions; client?: never });

/**
 * Provides one chat client to the tree. Pass `options` to let the provider
 * create (and on unmount disconnect) the client, or pass your own `client`.
 */
export function OcsoChatProvider(props: OcsoChatProviderProps) {
  const { children, autoConnect = true } = props;
  const [owned] = useState(() => (props.client ? null : createOcsoChat(props.options as OcsoChatOptions)));
  const client = props.client ?? (owned as OcsoChatClient);

  useEffect(() => {
    if (autoConnect) void client.connect().catch(() => undefined);
  }, [client, autoConnect]);

  useEffect(() => (owned ? () => owned.disconnect() : undefined), [owned]);

  return <OcsoChatContext.Provider value={client}>{children}</OcsoChatContext.Provider>;
}

/** The client from the nearest `OcsoChatProvider`. */
export function useOcsoChatClient(): OcsoChatClient {
  const client = useContext(OcsoChatContext);
  if (!client) throw new Error('useOcsoChat must be used inside <OcsoChatProvider>');
  return client;
}
