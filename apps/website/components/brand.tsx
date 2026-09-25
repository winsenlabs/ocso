/**
 * The Route mark (brand/ocso-mark.svg): one line comes in, the router splits it, and the chosen queue is lit.
 * Tile and strokes follow the colour scheme (dark tile on light, white tile on dark, as brand/README.md asks);
 * the lit dot is always the accent.
 */
export function Mark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="18" fill="var(--mark-tile)" />
      <path
        d="M15 32H23C31 32 33 20 44 20M23 32C31 32 33 44 44 44"
        fill="none"
        stroke="var(--mark-line)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="15" cy="32" r="4.5" fill="var(--mark-line)" />
      <circle cx="46" cy="20" r="5" fill="#3D5DCF" />
      <circle cx="46" cy="44" r="5" fill="var(--mark-line)" />
    </svg>
  );
}

/** Mark plus the wordmark (Geist Bold, tracked −3%, as in brand/ocso-logo.svg). */
export function Logo() {
  return (
    <span className="logo">
      <Mark size={30} />
      <span className="logo-word">OCSO</span>
    </span>
  );
}
