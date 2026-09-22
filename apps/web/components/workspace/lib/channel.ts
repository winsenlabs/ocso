import { CHANNEL_NAMES, type ChannelCode } from '../../../lib/channels';

/** API channel kinds (packages/channels CHANNEL_KINDS) → the design's two-letter marks. */
const KIND_TO_CODE: Readonly<Record<string, ChannelCode>> = {
  WHATSAPP: 'WA',
  TWILIO_WHATSAPP: 'WA',
  WEBCHAT: 'WB',
  CUSTOM_APP: 'AP',
  EMAIL: 'EM',
  VOICE: 'VO',
  INSTAGRAM: 'IG',
  SMS: 'SM',
  RCS: 'SM',
};

export function channelCode(kind: string | null | undefined): ChannelCode | null {
  return kind ? (KIND_TO_CODE[kind] ?? null) : null;
}

/** "WhatsApp", "Web chat", or the channel's configured name for kinds without a mark. */
export function channelLabel(kind: string | null | undefined, name?: string | null): string {
  const code = channelCode(kind);
  if (code) return CHANNEL_NAMES[code];
  return name ?? 'no channel';
}
