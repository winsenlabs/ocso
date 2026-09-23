'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { listProviderModelsAction } from '@/lib/actions/models';
import type { ModelList } from '@/lib/api/model-catalog';

/**
 * Model lists per provider for one profile dialog: the primary and every
 * fallback picker share one request per provider. The API caches listings for
 * ten minutes; `reload(true)` asks it to go back to the provider (admins).
 */

export type ModelListState =
  | { status: 'loading'; list: ModelList | null }
  | { status: 'ready'; list: ModelList }
  | { status: 'failed'; message: string };

interface Store {
  states: Readonly<Record<string, ModelListState>>;
  load(providerId: string, refresh: boolean): void;
}

const ModelListsContext = createContext<Store | null>(null);

export function ModelListsProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<string, ModelListState>>({});
  const requested = useRef(new Set<string>());

  const load = useCallback((providerId: string, refresh: boolean) => {
    if (!providerId || (!refresh && requested.current.has(providerId))) return;
    requested.current.add(providerId);
    setStates((s) => ({ ...s, [providerId]: { status: 'loading', list: s[providerId]?.status === 'ready' ? s[providerId].list : null } }));
    void listProviderModelsAction(providerId, refresh).then(
      (r) => setStates((s) => ({ ...s, [providerId]: r.ok ? { status: 'ready', list: r.data } : { status: 'failed', message: r.message } })),
      () => setStates((s) => ({ ...s, [providerId]: { status: 'failed', message: 'The model list could not be loaded.' } })),
    );
  }, []);

  const store = useMemo(() => ({ states, load }), [states, load]);
  return <ModelListsContext.Provider value={store}>{children}</ModelListsContext.Provider>;
}

/** The model list for one provider (loaded on first use). */
export function useProviderModels(providerId: string): { state: ModelListState | null; reload: () => void } {
  const store = useContext(ModelListsContext);
  const load = store?.load;
  useEffect(() => {
    if (providerId) load?.(providerId, false);
  }, [providerId, load]);
  return {
    state: providerId ? (store?.states[providerId] ?? null) : null,
    reload: () => load?.(providerId, true),
  };
}
