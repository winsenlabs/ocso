/**
 * Reconnect delay for the realtime stream: exponential from 1 s to 30 s with
 * ±20 % jitter so a fleet of browsers does not reconnect in lockstep after an
 * API restart. `attempt` counts consecutive failures, starting at 0.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 10)));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(base * jitter);
}
