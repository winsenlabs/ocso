import type { ChannelCode, ChannelMarkView } from '@/lib/channels';

export type { ChannelCode };

/** Tones the design system draws (app/styles: `.ch-mark.wa` …); anything else stays neutral. */
const TONES: ReadonlySet<string> = new Set(['wa', 'vo', 'ig']);

/**
 * Channel mark (.ch-mark): a short mono square, never a logo. Pass a kind's
 * `mark` from its descriptor, or a bare code (design previews).
 */
export function ChannelMark({ channel, mark, size }: { channel?: ChannelCode; mark?: ChannelMarkView | null; size?: 'lg' }) {
  const code = mark?.code ?? channel;
  if (!code) return null;
  const tone = mark?.tone && TONES.has(mark.tone) ? mark.tone : undefined;
  const label = mark?.name ?? code;
  const classes = ['ch-mark', tone, size].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={label} title={label}>
      {code}
    </span>
  );
}
