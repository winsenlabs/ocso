/**
 * OCSO brand mark, "Route" (brand/ocso-mark.svg): one line in, the router
 * splits it, the chosen queue lit. Decorative unless a title is given.
 */
function RouteGlyph({ stroke, lit }: { stroke: string; lit: string }) {
  return (
    <>
      <path d="M15 32H23C31 32 33 20 44 20M23 32C31 32 33 44 44 44" fill="none" stroke={stroke} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="15" cy="32" r="4.5" fill={stroke} />
      <circle cx="46" cy="20" r="5" fill={lit} />
      <circle cx="46" cy="44" r="5" fill={stroke} />
    </>
  );
}

export function BrandMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      style={{ display: 'block' }}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <rect width="64" height="64" rx="18" fill="var(--ink)" />
      <RouteGlyph stroke="var(--bg)" lit="var(--accent)" />
    </svg>
  );
}

/** The internal agent's portrait (Ask OCSO button and drawer header): the mark's glyph in white. */
export function AgentPortrait({ background = 'oklch(100% 0 0/0.2)' }: { background?: string }) {
  return (
    <span className="a-portrait md" style={{ background }} aria-hidden="true">
      <svg viewBox="0 0 64 64" style={{ width: '100%', height: '100%', display: 'block' }}>
        <RouteGlyph stroke="#fff" lit="#fff" />
      </svg>
    </span>
  );
}
