/** Text helpers that never split a UTF-16 surrogate pair. */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Largest index <= `index` that does not fall between a surrogate pair. */
export function safeCutIndex(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(index, text.length));
  return isHighSurrogate(text.charCodeAt(index - 1)) ? index - 1 : index;
}

/** Truncate to at most `max` UTF-16 units, without breaking surrogate pairs. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, safeCutIndex(text, max));
}

/** Truncate with an ellipsis when too long (result length <= max). */
export function truncateWithEllipsis(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, safeCutIndex(text, max - 1))}…`;
}

/** Trimmed string or undefined when empty. */
export function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
