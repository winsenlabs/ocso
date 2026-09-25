/**
 * The Route mark (brand/ocso-mark.svg): one line comes in, the router splits it, and the chosen queue is lit.
 * Two colourings, as brand/README.md asks: a dark tile on light backgrounds, a white tile on dark ones.
 * The lit dot is always the accent.
 */
const TONES = {
  'on-light': { tile: '#11171D', line: '#FFFFFF' },
  'on-dark': { tile: '#FFFFFF', line: '#11171D' },
} as const;

export function Mark({ tone = 'on-dark', className = 'size-8' }: { tone?: keyof typeof TONES; className?: string }) {
  const t = TONES[tone];
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="18" fill={t.tile} />
      <path d="M15 32H23C31 32 33 20 44 20M23 32C31 32 33 44 44 44" fill="none" stroke={t.line} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="15" cy="32" r="4.5" fill={t.line} />
      <circle cx="46" cy="20" r="5" fill="#3D5DCF" />
      <circle cx="46" cy="44" r="5" fill={t.line} />
    </svg>
  );
}

/** Picks the colouring for the page theme. Not for use inside an .on-dark island. */
export function ThemedMark({ className = 'size-8' }: { className?: string }) {
  return (
    <>
      <Mark tone="on-dark" className={`${className} light:hidden`} />
      <Mark tone="on-light" className={`${className} hidden light:block`} />
    </>
  );
}
