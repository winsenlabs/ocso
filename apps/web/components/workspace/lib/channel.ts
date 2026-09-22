import { markOfKind, type ChannelMarkView } from '../../../lib/channels';

/** Kind descriptors as the workspace needs them (GET /v1/channels/kinds, see lib/api/channels.ts). */
export type KindMarks = ReadonlyArray<{ kind: string; mark: ChannelMarkView | null }>;

/** The mark a channel kind's adapter declares; null for kinds the API does not describe. */
export function channelMark(kinds: KindMarks, kind: string | null | undefined): ChannelMarkView | null {
  return markOfKind(kinds, kind);
}

/** The network's name from the kind's mark ("WhatsApp", "Web chat"), else the channel's configured name. */
export function channelLabel(kinds: KindMarks, kind: string | null | undefined, name?: string | null): string {
  return channelMark(kinds, kind)?.name ?? name ?? 'no channel';
}
