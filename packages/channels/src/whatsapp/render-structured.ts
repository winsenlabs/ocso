import { z } from 'zod';
import { choicesOf, type ChoicesData, type InteractionPart } from '@ocso/domain';
import { renderChoicesAsText } from '../contract/choices.js';
import { chunkText } from '../common/chunk.js';
import { truncateWithEllipsis } from '../common/text.js';
import {
  WHATSAPP_BUTTON_ID_LIMIT,
  WHATSAPP_BUTTON_TITLE_LIMIT,
  WHATSAPP_INTERACTIVE_BODY_LIMIT,
  WHATSAPP_INTERACTIVE_FOOTER_LIMIT,
  WHATSAPP_INTERACTIVE_HEADER_LIMIT,
  WHATSAPP_LIST_ROW_ID_LIMIT,
  WHATSAPP_LIST_ROW_TITLE_LIMIT,
  WHATSAPP_MAX_LIST_ROWS,
  WHATSAPP_MAX_REPLY_BUTTONS,
  WHATSAPP_TEXT_LIMIT,
} from './capabilities.js';
import { toWhatsAppText } from './format.js';
import type { WhatsAppOutboundPayload } from './payload.js';

/**
 * STRUCTURED parts. Schema `buttons` with 1–3 distinct buttons becomes an
 * interactive reply-button message (titles cut to 20 chars, body to 1024).
 * Everything else falls back to `fallbackText`; `buttons` without one gets a
 * generated numbered list. Structures with no text form are not rendered.
 */

export const OUTBOUND_BUTTONS_SCHEMA = 'buttons';

const ButtonsData = z.object({
  body: z.string().min(1),
  header: z.string().optional(),
  footer: z.string().optional(),
  buttons: z.array(z.object({ id: z.string().min(1).max(WHATSAPP_BUTTON_ID_LIMIT), title: z.string().min(1) })).min(1),
});
type ButtonsData = z.infer<typeof ButtonsData>;

type StructuredPart = Extract<InteractionPart, { type: 'STRUCTURED' }>;

export function textPayloads(markdown: string): WhatsAppOutboundPayload[] {
  return chunkText(toWhatsAppText(markdown), WHATSAPP_TEXT_LIMIT).map((body) => ({
    type: 'text',
    body,
    previewUrl: /https?:\/\//.test(body),
  }));
}

function plain(value: string | undefined, limit: number): string | undefined {
  const text = value ? toWhatsAppText(value) : '';
  return text ? truncateWithEllipsis(text, limit) : undefined;
}

function canBeInteractive(data: ButtonsData): boolean {
  if (data.buttons.length > WHATSAPP_MAX_REPLY_BUTTONS) return false;
  const titles = data.buttons.map((b) => truncateWithEllipsis(b.title.trim(), WHATSAPP_BUTTON_TITLE_LIMIT));
  const ids = data.buttons.map((b) => b.id);
  return new Set(titles).size === titles.length && new Set(ids).size === ids.length && titles.every(Boolean);
}

function interactivePayload(data: ButtonsData): WhatsAppOutboundPayload {
  const header = plain(data.header, WHATSAPP_INTERACTIVE_HEADER_LIMIT);
  const footer = plain(data.footer, WHATSAPP_INTERACTIVE_FOOTER_LIMIT);
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(header ? { header: { type: 'text' as const, text: header } } : {}),
      body: { text: plain(data.body, WHATSAPP_INTERACTIVE_BODY_LIMIT) ?? '…' },
      ...(footer ? { footer: { text: footer } } : {}),
      action: {
        buttons: data.buttons.map((b) => ({
          type: 'reply' as const,
          reply: { id: b.id, title: truncateWithEllipsis(b.title.trim(), WHATSAPP_BUTTON_TITLE_LIMIT) },
        })),
      },
    },
  };
}

function numberedList(data: ButtonsData): string {
  return [data.body, '', ...data.buttons.map((b, i) => `${i + 1}. ${b.title}`)].join('\n');
}

/** Opening button of a list message (Meta requires one; ≤ 20 characters). */
export const LIST_BUTTON_TEXT = 'Choose';

const distinct = (values: readonly string[]) => new Set(values.map((v) => v.toLowerCase())).size === values.length;

/**
 * CHOICES (PM/research/11 §5.4): ≤ 3 options → reply buttons, ≤ 10 → a list
 * message, else numbered text. Titles are cut to Meta's limits; when cutting
 * makes two titles equal, or an option id is too long, the numbered text is
 * sent instead (the customer answers with a number or the label).
 */
function renderChoices(data: ChoicesData): WhatsAppOutboundPayload[] {
  const body = plain(data.text, WHATSAPP_INTERACTIVE_BODY_LIMIT) ?? '…';
  if (data.options.length <= WHATSAPP_MAX_REPLY_BUTTONS) {
    const titles = data.options.map((o) => truncateWithEllipsis(o.label.trim(), WHATSAPP_BUTTON_TITLE_LIMIT));
    if (distinct(titles) && data.options.every((o) => o.id.length <= WHATSAPP_BUTTON_ID_LIMIT)) {
      return [{ type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: data.options.map((o, i) => ({ type: 'reply' as const, reply: { id: o.id, title: titles[i]! } })) } } }];
    }
  }
  if (data.options.length <= WHATSAPP_MAX_LIST_ROWS) {
    const titles = data.options.map((o) => truncateWithEllipsis(o.label.trim(), WHATSAPP_LIST_ROW_TITLE_LIMIT));
    if (distinct(titles) && data.options.every((o) => o.id.length <= WHATSAPP_LIST_ROW_ID_LIMIT)) {
      return [{ type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button: LIST_BUTTON_TEXT, sections: [{ rows: data.options.map((o, i) => ({ id: o.id, title: titles[i]! })) }] } } }];
    }
  }
  return textPayloads(renderChoicesAsText(data));
}

export function renderStructured(part: StructuredPart): WhatsAppOutboundPayload[] {
  const choices = choicesOf(part);
  if (choices) return renderChoices(choices);
  const buttons = part.schema === OUTBOUND_BUTTONS_SCHEMA ? ButtonsData.safeParse(part.data) : null;
  if (buttons?.success && canBeInteractive(buttons.data)) return [interactivePayload(buttons.data)];
  if (part.fallbackText?.trim()) return textPayloads(part.fallbackText);
  if (buttons?.success) return textPayloads(numberedList(buttons.data));
  return [];
}
