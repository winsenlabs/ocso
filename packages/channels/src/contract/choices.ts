import { choicesOf, choicesText, type ChoicesData, type InteractionPart } from '@ocso/domain';
import type { ChannelCapabilities } from './types.js';

/**
 * The CHOICES part (a question with options, PM/research/11 §5.4) for
 * adapters. Core writes it as a STRUCTURED `ocso.choices` part; an adapter
 * renders it natively when it declares `capabilities.choices`, otherwise as
 * numbered text a customer answers with the number or the label.
 */
export { CHOICES_SCHEMA, choicesOf, type ChoicesData } from '@ocso/domain';

/** "Which product?\n\n1. Cards\n2. Loans" — the text form every channel can send. */
export function renderChoicesAsText(data: ChoicesData): string {
  return choicesText(data);
}

/** How a channel shows these choices: native buttons, a native list, or text. */
export function choicesPresentation(data: ChoicesData, capabilities: ChannelCapabilities): 'buttons' | 'list' | 'text' {
  const native = capabilities.choices;
  if (!native) return 'text';
  if (data.options.length <= native.buttons) return 'buttons';
  if (data.options.length <= native.list) return 'list';
  return 'text';
}

/** The choices of a part, if it is a CHOICES part. */
export function choicesPart(part: InteractionPart): ChoicesData | null {
  return choicesOf(part);
}
