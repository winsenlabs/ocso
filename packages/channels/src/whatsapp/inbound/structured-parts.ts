import { z } from 'zod';
import type { InteractionPart } from '@ocso/domain';
import { clip, nonEmpty } from '../../common/text.js';
import type { WaMessage } from './schema.js';

/**
 * Normalizers producing STRUCTURED parts: interactive replies, legacy
 * template quick-reply buttons, reactions, WhatsApp Flow responses and
 * click-to-WhatsApp ad referrals. Every part carries a `fallbackText` so
 * text-only consumers (model context, previews) still see what happened.
 */

export const STRUCTURED_SCHEMAS = {
  BUTTON_REPLY: 'button_reply',
  LIST_REPLY: 'list_reply',
  FLOW_REPLY: 'flow_reply',
  REACTION: 'reaction',
  REFERRAL: 'referral',
} as const;

const FALLBACK_MAX = 4_000;

function structured(schema: string, data: Record<string, unknown>, fallbackText: string): InteractionPart {
  return { type: 'STRUCTURED', schema, data, fallbackText: clip(fallbackText, FALLBACK_MAX) };
}

const Reply = z.object({ id: z.string(), title: z.string(), description: z.string().optional() });
const FlowReply = z.object({ name: z.string().optional(), body: z.string().optional(), response_json: z.string() });

type InteractiveNormalizer = (value: unknown) => InteractionPart | null;

const INTERACTIVE: ReadonlyMap<string, InteractiveNormalizer> = new Map<string, InteractiveNormalizer>([
  [
    'button_reply',
    (value) => {
      const reply = Reply.safeParse(value);
      if (!reply.success) return null;
      const { id, title } = reply.data;
      return structured(STRUCTURED_SCHEMAS.BUTTON_REPLY, { id, title, source: 'interactive' }, title);
    },
  ],
  [
    'list_reply',
    (value) => {
      const reply = Reply.safeParse(value);
      if (!reply.success) return null;
      const { id, title, description } = reply.data;
      const fallback = description ? `${title} — ${description}` : title;
      return structured(STRUCTURED_SCHEMAS.LIST_REPLY, { id, title, description: description ?? null }, fallback);
    },
  ],
  [
    'nfm_reply',
    (value) => {
      const reply = FlowReply.safeParse(value);
      if (!reply.success) return null;
      let response: unknown;
      try {
        response = JSON.parse(reply.data.response_json);
      } catch {
        return null;
      }
      const name = reply.data.name ?? 'flow';
      return structured(STRUCTURED_SCHEMAS.FLOW_REPLY, { name, response }, reply.data.body ?? `[form submitted: ${name}]`);
    },
  ],
]);

export function normalizeInteractive(message: WaMessage): InteractionPart[] | null {
  const parsed = z.looseObject({ type: z.string() }).safeParse(message['interactive']);
  if (!parsed.success) return null;
  const normalize = INTERACTIVE.get(parsed.data.type);
  const part = normalize?.(parsed.data[parsed.data.type]);
  return part ? [part] : null;
}

const LegacyButton = z.object({ payload: z.string().optional(), text: z.string() });

/** Template quick-reply buttons arrive as `type: "button"` with `{payload, text}`. */
export function normalizeLegacyButton(message: WaMessage): InteractionPart[] | null {
  const parsed = LegacyButton.safeParse(message['button']);
  if (!parsed.success) return null;
  const { payload, text } = parsed.data;
  return [structured(STRUCTURED_SCHEMAS.BUTTON_REPLY, { id: payload ?? text, title: text, source: 'template' }, text)];
}

const Reaction = z.object({ message_id: z.string().min(1), emoji: z.string().optional() });

/** Meta signals reaction removal by omitting `emoji` (or sending it empty). */
export function normalizeReaction(message: WaMessage): InteractionPart[] | null {
  const parsed = Reaction.safeParse(message['reaction']);
  if (!parsed.success) return null;
  const emoji = nonEmpty(parsed.data.emoji) ?? null;
  const data = { messageId: parsed.data.message_id, emoji, action: emoji ? 'added' : 'removed' };
  return [structured(STRUCTURED_SCHEMAS.REACTION, data, emoji ? `Reacted ${emoji} to a message` : 'Removed a reaction')];
}

/** Click-to-WhatsApp ad context, appended to the message's own parts. */
export function referralPart(message: WaMessage): InteractionPart | null {
  const referral = message.referral;
  if (!referral) return null;
  const data = {
    sourceType: referral.source_type ?? null,
    sourceId: referral.source_id ?? null,
    sourceUrl: referral.source_url ?? null,
    headline: referral.headline ?? null,
    body: referral.body ?? null,
    ctwaClid: referral.ctwa_clid ?? null,
  };
  const label = nonEmpty(referral.headline) ?? nonEmpty(referral.source_type) ?? 'ad';
  return structured(STRUCTURED_SCHEMAS.REFERRAL, data, `[arrived via ${label}]`);
}
