/** OCSO brand mark (design/OCSONav.dc.html). Decorative unless a title is given. */
export function BrandMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      viewBox="0 0 56 56"
      width={size}
      height={size}
      style={{ display: 'block' }}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <rect width="56" height="56" rx="16" fill="var(--ink)" />
      <circle cx="28" cy="28" r="12" fill="none" stroke="var(--bg)" strokeWidth="5" />
      <circle cx="28" cy="16" r="4.5" fill="var(--accent)" stroke="var(--ink)" strokeWidth="2.5" />
    </svg>
  );
}

/** The internal agent's portrait (Ask OCSO button and drawer header). */
export function AgentPortrait({ background = 'oklch(100% 0 0/0.2)' }: { background?: string }) {
  return (
    <span className="a-portrait md" style={{ background }} aria-hidden="true">
      <svg viewBox="0 0 56 56" style={{ width: '100%', height: '100%', display: 'block' }}>
        <circle cx="28" cy="28" r="12" fill="none" stroke="#fff" strokeWidth="5" />
        <circle cx="28" cy="16" r="4" fill="#fff" />
      </svg>
    </span>
  );
}
