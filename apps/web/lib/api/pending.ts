import 'server-only';

/**
 * Marks a loader whose API endpoint has not shipped yet (docs/14). It resolves
 * to `null` so pages render an explicit "no data yet" state instead of
 * invented numbers. Replace the call with a real `api.get(...)` when the
 * endpoint lands; the page components already render the non-null shape.
 */
export async function notYetAvailable<T>(endpoint: `${'GET'} /v1/${string}`): Promise<T | null> {
  void endpoint;
  return null;
}
