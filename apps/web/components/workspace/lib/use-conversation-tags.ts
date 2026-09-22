'use client';

import { useCallback, useOptimistic, useState, useTransition } from 'react';
import { setTagsAction } from '../../../lib/actions/conversations';
import { withTag, withoutTag } from './tags';
import { WORKSPACE_CHANGED } from './use-action';

export interface ConversationTags {
  /** Optimistic while a save is in flight; otherwise what the API last returned (server props). */
  tags: string[];
  pending: boolean;
  error: string | null;
  /** Adds a tag; returns a validation message (and saves nothing) when the tag is not allowed. */
  add: (raw: string) => string | null;
  remove: (tag: string) => void;
}

/**
 * Tag edits for one conversation: the chip changes at once, the full set is
 * PUT to the API, and the refreshed server props (the normalized set the API
 * stored) replace the optimistic value — or restore the old one on failure.
 */
export function useConversationTags(conversationId: string, serverTags: string[]): ConversationTags {
  const [tags, setOptimistic] = useOptimistic(serverTags);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback(
    (next: string[]) => {
      setError(null);
      startTransition(async () => {
        setOptimistic(next);
        const result = await setTagsAction(conversationId, next).catch(() => ({ ok: false as const, message: 'Could not save tags. Try again.' }));
        if (!result.ok) setError(result.message);
        else window.dispatchEvent(new Event(WORKSPACE_CHANGED));
      });
    },
    [conversationId, setOptimistic],
  );

  const add = useCallback(
    (raw: string) => {
      const edit = withTag(tags, raw);
      if (!edit.ok) return edit.message;
      if (edit.changed) commit(edit.tags);
      return null;
    },
    [tags, commit],
  );

  const remove = useCallback((tag: string) => commit(withoutTag(tags, tag)), [tags, commit]);

  return { tags, pending, error, add, remove };
}
