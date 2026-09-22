/**
 * Conversation tag rules, mirrored from packages/application/src/conversations/tags.ts
 * so the workspace can validate and render optimistically. The API stays the
 * authority: what it stores replaces the optimistic value.
 */

export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,39}$/;
export const MAX_TAGS = 20;
export const TAG_RULE = '1–40 characters: letters, digits, spaces, “-” or “_”, starting with a letter or digit';

/** trim → lowercase → collapse inner whitespace (same as the API). */
export const normalizeTag = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, ' ');

export const isValidTag = (tag: string): boolean => TAG_PATTERN.test(tag);

export type TagEdit = { ok: true; tags: string[]; changed: boolean } | { ok: false; message: string };

/** Add one tag to a set: normalized, de-duplicated, validated, capped. */
export function withTag(tags: readonly string[], raw: string): TagEdit {
  const tag = normalizeTag(raw);
  if (!isValidTag(tag)) return { ok: false, message: `Tags are ${TAG_RULE}.` };
  if (tags.includes(tag)) return { ok: true, tags: [...tags], changed: false };
  if (tags.length >= MAX_TAGS) return { ok: false, message: `A conversation can have at most ${MAX_TAGS} tags.` };
  return { ok: true, tags: [...tags, tag], changed: true };
}

export const withoutTag = (tags: readonly string[], tag: string): string[] => tags.filter((t) => t !== tag);

/** A valid, normalized tag from a URL parameter, or null. */
export function tagParam(value: string | null | undefined): string | null {
  if (!value) return null;
  const tag = normalizeTag(value);
  return isValidTag(tag) ? tag : null;
}

/** Suggestions not already on the conversation, most used first (the API's order). */
export function freshSuggestions(items: ReadonlyArray<{ tag: string; count: number }>, present: readonly string[], limit = 8): Array<{ tag: string; count: number }> {
  return items.filter((i) => !present.includes(i.tag)).slice(0, limit);
}

/** Inbox link keeping the current params, with the tag filter set (or cleared with null). */
export function hrefWithTag(pathname: string, params: URLSearchParams | string, tag: string | null): string {
  const next = new URLSearchParams(params);
  if (tag) next.set('tag', tag);
  else next.delete('tag');
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** Arrow-key movement through `count` options; -1 is the text box itself (the list wraps through it). */
export function moveActive(current: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1;
  const next = current + step;
  if (next >= count) return -1;
  if (next < -1) return count - 1;
  return next;
}
