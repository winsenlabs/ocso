/** Tag chips shown on an inbox row before "+N". */
const ROW_TAGS = 3;

/** Compact, non-interactive tag chips inside an inbox row link (the filtered tag is highlighted). */
export function RowTags({ tags, activeTag }: { tags: readonly string[]; activeTag: string | null }) {
  if (tags.length === 0) return null;
  return (
    <span className="rtags" title={tags.join(', ')}>
      <span className="sr-only">tags </span>
      {tags.slice(0, ROW_TAGS).map((t) => (
        <span className={t === activeTag ? 'chip accent' : 'chip'} key={t}>
          {t}
        </span>
      ))}
      {tags.length > ROW_TAGS ? <span className="chip">+{tags.length - ROW_TAGS}</span> : null}
    </span>
  );
}
