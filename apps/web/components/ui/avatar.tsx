export type AvatarTone = 'indigo' | 'violet' | 'rose' | 'amber' | 'emerald' | 'sky' | 'teal' | 'walle';

export interface AvatarProps {
  initials: string;
  tone?: AvatarTone;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible name; decorative when omitted. */
  label?: string;
}

/** Rounded-square initials avatar (.avatar) for agents and people. */
export function Avatar({ initials, tone = 'indigo', size = 'md', label }: AvatarProps) {
  const classes = ['avatar', size === 'md' ? undefined : size, tone].filter(Boolean).join(' ');
  return (
    <span className={classes} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {initials}
    </span>
  );
}
