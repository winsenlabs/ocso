import { CHANNEL_NAMES, type ChannelCode } from '@/lib/channels';

export type { ChannelCode };

const TONE: Partial<Record<ChannelCode, string>> = { WA: 'wa', VO: 'vo', IG: 'ig' };

/** Channel mark (.ch-mark): two-letter mono square, never a logo. */
export function ChannelMark({ channel, size }: { channel: ChannelCode; size?: 'lg' }) {
  const classes = ['ch-mark', TONE[channel], size].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={CHANNEL_NAMES[channel]} title={CHANNEL_NAMES[channel]}>
      {channel}
    </span>
  );
}
