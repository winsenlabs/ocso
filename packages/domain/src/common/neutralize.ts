/**
 * Untrusted or dynamic text placed in a model prompt is neutralized so it can never close its own wrapper and
 * masquerade as instructions (docs/archive/specs/05 §7): control characters are dropped and OCSO's own wrapper
 * tags are defanged. Pure, so the web builder can preview prompts exactly as the server builds them.
 */
export function neutralize(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<\/?(ocso_[a-z_]+|customer_context|conversation_summary|handover|conversation)>/gi, (m) => m.replace('<', '‹').replace('>', '›'));
}
