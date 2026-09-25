import { z } from 'zod';

/**
 * Channel marks as the UI draws them (docs/archive/specs/07). Each kind's mark comes from
 * its adapter's descriptor (GET /v1/channels/kinds): a short code, the
 * network's name, and optionally a design-system tone. Nothing here knows a
 * channel kind.
 */
export const ChannelMarkSchema = z.object({
  /** Two-character badge text, e.g. `WA`. */
  code: z.string().min(1).max(3),
  /** The network customers use ("WhatsApp"). */
  name: z.string(),
  /** Design-system tone of the badge (`wa`, `vo`, `ig`). */
  tone: z.string().optional(),
});
export type ChannelMarkView = z.infer<typeof ChannelMarkSchema>;

/** Badge text shown by ChannelMark (a mark's `code`). */
export type ChannelCode = string;

/** The mark of a kind in a list of kind descriptors; null for unknown kinds (the UI shows the channel name instead). */
export function markOfKind(kinds: ReadonlyArray<{ kind: string; mark: ChannelMarkView | null }>, kind: string | null | undefined): ChannelMarkView | null {
  if (!kind) return null;
  return kinds.find((k) => k.kind === kind)?.mark ?? null;
}
