'use client';

import { useCallback, useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/actions/agents';

/** Runs an agent server action with pending state and a user-safe error. */
export function useAgentAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(<T,>(fn: () => Promise<ActionResult<T>>, onOk?: (data: T) => void) => {
    setError(null);
    start(async () => {
      try {
        const result = await fn();
        if (!result.ok) setError(result.message);
        else onOk?.(result.data);
      } catch {
        setError('Something went wrong. Try again.');
      }
    });
  }, []);
  return { pending, error, setError, run };
}
