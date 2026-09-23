'use client';

import { useCallback, useState, useTransition } from 'react';
import type { ActionResult } from '../../../lib/actions/conversations';

/** Window event fired after a successful workspace action (the inbox re-queries on it). */
export const WORKSPACE_CHANGED = 'ocso:workspace-changed';

/**
 * Runs a server action with pending state and a user-safe error message.
 * Resolves to true on success so callers can reset forms or close dialogs.
 */
export function useActionRunner(): {
  pending: boolean;
  error: string | null;
  clearError: () => void;
  run: (fn: () => Promise<ActionResult>) => Promise<boolean>;
} {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (fn: () => Promise<ActionResult>) =>
      new Promise<boolean>((resolve) => {
        setError(null);
        startTransition(async () => {
          try {
            const result = await fn();
            if (!result.ok) setError(result.message);
            // The page refreshes itself (server action); tell the inbox pane to re-query now too.
            else window.dispatchEvent(new Event(WORKSPACE_CHANGED));
            resolve(result.ok);
          } catch {
            setError('Something went wrong. Try again.');
            resolve(false);
          }
        });
      }),
    [],
  );

  return { pending, error, clearError: useCallback(() => setError(null), []), run };
}
