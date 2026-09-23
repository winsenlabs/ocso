'use client';

import { useEffect, useState } from 'react';
import { normalizeTag } from './tags';

export interface TagSuggestion {
  tag: string;
  count: number;
}

/**
 * Most used tags matching `text` (debounced), from /api/conversations/tags —
 * the API only counts conversations this user can see. Failures leave the
 * list empty: autocomplete is a convenience, typing a new tag always works.
 */
export function useTagSuggestions(text: string, enabled: boolean, limit = 12): TagSuggestion[] {
  const [items, setItems] = useState<TagSuggestion[]>([]);
  const prefix = normalizeTag(text);

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (prefix) params.set('prefix', prefix);
      fetch(`/api/conversations/tags?${params.toString()}`, { cache: 'no-store', signal: ctrl.signal })
        .then(async (res) => (res.ok ? ((await res.json()) as { items?: TagSuggestion[] }) : { items: [] }))
        .then((body) => setItems(body.items ?? []))
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [prefix, enabled, limit]);

  return enabled ? items.filter((i) => i.tag.startsWith(prefix)) : [];
}
