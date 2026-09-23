import type { ModelMessage, SystemBlock } from '@ocso/domain';

export const COPILOT_STYLES = ['default', 'shorter', 'warmer', 'formal'] as const;
export type CopilotStyle = (typeof COPILOT_STYLES)[number];

const STYLE_HINT: Record<CopilotStyle, string> = {
  default: 'Match the tone the organization uses above.',
  shorter: 'Make it noticeably shorter: one or two sentences, no pleasantries beyond one short greeting or sign-off.',
  warmer: 'Make it warmer and more empathetic without adding promises or new facts.',
  formal: 'Make it more formal and precise without adding promises or new facts.',
};

/** Marker for the operator request so it is never mistaken for a customer message. */
export const COPILOT_REQUEST_MARKER = '[OCSO copilot request from your colleague — this is not a customer message]';

/**
 * Appended after the agent's own compiled prompt, so the provider prompt cache
 * for the agent prefix is reused (docs/05 §3): only this block and the request
 * message are new.
 */
export function copilotInstruction(input: { forName: string | null; style: CopilotStyle; baseText: string | null }): SystemBlock {
  const who = input.forName ? `${input.forName}, a human colleague` : 'a human colleague';
  const lines = [
    '## Copilot mode',
    `The conversation is now handled by ${who}. You are NOT replying to the customer yourself.`,
    'When you receive the copilot request marker, draft the next message the colleague could send to the customer.',
    '- Write as the organization, in the customer\'s language, following every policy above.',
    '- Never state that an action happened unless a tool result or colleague message in this conversation confirms it.',
    '- Do not invent reference numbers, amounts, dates or policy identifiers.',
    `- ${STYLE_HINT[input.style]}`,
    'Answer in exactly this format and nothing else:',
    '<draft>the message text</draft>',
    '<policies>comma-separated policy identifiers from the instructions above that the draft relies on, or empty</policies>',
  ];
  if (input.baseText) {
    lines.push('', 'Rewrite this existing draft instead of writing a new one (keep its facts):', `<existing>${input.baseText.replaceAll('<', '‹')}</existing>`);
  }
  return { key: 'copilot_mode', text: lines.join('\n'), stable: false };
}

export const copilotRequest = (): ModelMessage => ({ role: 'user', content: [{ type: 'text', text: COPILOT_REQUEST_MARKER }] });

/** Tolerant parse: tagged output preferred; otherwise the whole text is the draft. */
export function parseCopilotOutput(raw: string): { text: string; policyRefs: string[] } {
  const draft = /<draft>([\s\S]*?)(?:<\/draft>|$)/i.exec(raw)?.[1];
  const policies = /<policies>([\s\S]*?)(?:<\/policies>|$)/i.exec(raw)?.[1] ?? '';
  const text = (draft ?? raw.replace(/<policies>[\s\S]*$/i, '')).trim();
  const policyRefs = [...new Set(policies.split(/[,\n]/).map((p) => p.trim()).filter((p) => p.length > 0 && p.length <= 64))];
  return { text, policyRefs };
}

/** Keep only identifiers that literally appear in the agent's instructions (no invented citations). */
export function groundPolicyRefs(refs: readonly string[], system: readonly SystemBlock[]): string[] {
  const corpus = system.filter((b) => b.key !== 'copilot_mode').map((b) => b.text).join('\n');
  return refs.filter((ref) => corpus.includes(ref));
}
