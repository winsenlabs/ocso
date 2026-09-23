import { z } from 'zod';
import type { InteractionPart } from '../interaction/parts.js';
import type { RouterReply } from './router-match.js';

/**
 * The CHOICES outbound part (PM/research/11 §5.4): a question with options.
 * Carried as a STRUCTURED part with schema `ocso.choices` so every channel,
 * transcript and model view that understands STRUCTURED (with its numbered
 * `fallbackText`) keeps working; channels that declare the `choices`
 * capability render it natively (buttons, lists). Inbound taps arrive as
 * STRUCTURED replies whose `data.id` is the option id.
 */
export const CHOICES_SCHEMA = 'ocso.choices';

export const ChoiceOptionSchema = z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(60) });
export const ChoicesDataSchema = z.object({ text: z.string().min(1).max(4_000), options: z.array(ChoiceOptionSchema).min(1).max(10) });
export type ChoicesData = z.infer<typeof ChoicesDataSchema>;

/** Numbered-text form of a choice question (what text-only channels send). */
export function choicesText(data: ChoicesData): string {
  return [data.text, '', ...data.options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n');
}

export function choicesPart(data: ChoicesData): InteractionPart {
  return { type: 'STRUCTURED', schema: CHOICES_SCHEMA, data: { text: data.text, options: data.options.map((o) => ({ id: o.id, label: o.label })) }, fallbackText: choicesText(data).slice(0, 4_000) };
}

/** The choice question in a part, or null when the part is something else. */
export function choicesOf(part: InteractionPart): ChoicesData | null {
  if (part.type !== 'STRUCTURED' || part.schema !== CHOICES_SCHEMA) return null;
  const parsed = ChoicesDataSchema.safeParse(part.data);
  return parsed.success ? parsed.data : null;
}

/** A customer message as a router reply: its text (typed or the tapped option's title) and tapped ids. */
export function routerReplyOf(parts: readonly InteractionPart[]): RouterReply {
  const text: string[] = [];
  const choiceIds: string[] = [];
  for (const part of parts) {
    if (part.type === 'TEXT') text.push(part.text);
    if (part.type === 'STRUCTURED') {
      const id = part.data['id'];
      if (typeof id === 'string') choiceIds.push(id);
      if (part.fallbackText) text.push(part.fallbackText);
    }
  }
  return { text: text.join(' ').trim(), choiceIds };
}
