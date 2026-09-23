/**
 * Provider-agnostic token estimate for UI display and budgeting ("412 tokens").
 * Real counts always come from provider usage; this is only an estimate.
 * ~4 characters per token for Latin text; non-Latin scripts tokenize denser.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
