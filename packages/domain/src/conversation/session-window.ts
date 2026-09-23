/**
 * A channel's customer-service window (docs/07 §3; the adapter declares its
 * length, e.g. 24 hours on WhatsApp): free-form replies are allowed for
 * `hours` after the customer's last message; afterwards only an approved
 * message template reaches them. `null` = the channel has no window.
 */
export interface SessionWindowState {
  open: boolean;
  /** When the window closes (ISO); null when it never opened (no customer message yet). */
  closesAt: string | null;
  /** Length of the window, from the channel adapter. */
  hours: number;
}

export function sessionWindowState(hours: number | null, lastInboundAt: Date | null, now: Date): SessionWindowState | null {
  if (hours === null) return null;
  if (!lastInboundAt) return { open: false, closesAt: null, hours };
  const closesAt = new Date(lastInboundAt.getTime() + hours * 3_600_000);
  return { open: now.getTime() < closesAt.getTime(), closesAt: closesAt.toISOString(), hours };
}
