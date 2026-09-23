import type { InteractionPart } from '@ocso/domain';
import { clip, nonEmpty } from '../../common/text.js';
import { STRUCTURED_SCHEMAS } from '../../whatsapp/inbound/structured-parts.js';
import type { FormRecord } from '../form.js';

/**
 * STRUCTURED parts from Twilio's rich-message fields, using the same schemas
 * as the Meta adapter (`button_reply`, `flow_reply`, `referral`) so the
 * runtime sees one WhatsApp vocabulary. Each carries a `fallbackText`.
 */

const FALLBACK_MAX = 4_000;

function structured(schema: string, data: Record<string, unknown>, fallbackText: string): InteractionPart {
  return { type: 'STRUCTURED', schema, data, fallbackText: clip(fallbackText, FALLBACK_MAX) };
}

/** Quick-reply / call-to-action button taps: `ButtonText`, `ButtonPayload`, `ButtonType`. */
export function buttonPart(form: FormRecord): InteractionPart | null {
  const title = nonEmpty(form['ButtonText']);
  if (!title) return null;
  const id = nonEmpty(form['ButtonPayload']) ?? title;
  const buttonType = nonEmpty(form['ButtonType'])?.toLowerCase() ?? null;
  return structured(STRUCTURED_SCHEMAS.BUTTON_REPLY, { id: clip(id, 256), title: clip(title, 256), source: 'content_template', buttonType }, title);
}

/** WhatsApp Flow completion (`FlowData`, serialized JSON). */
export function flowPart(form: FormRecord): InteractionPart | null {
  const raw = nonEmpty(form['FlowData']);
  if (!raw) return null;
  let response: unknown;
  try {
    response = JSON.parse(raw);
  } catch {
    return null;
  }
  return structured(STRUCTURED_SCHEMAS.FLOW_REPLY, { name: 'flow', response }, '[form submitted: flow]');
}

/** Click-to-WhatsApp ad context (`Referral*`), appended to the message's own parts. */
export function referralPart(form: FormRecord): InteractionPart | null {
  const field = (name: string) => nonEmpty(form[`Referral${name}`]) ?? null;
  const data = {
    sourceType: field('SourceType'),
    sourceId: field('SourceId'),
    sourceUrl: field('SourceUrl'),
    headline: field('Headline'),
    body: field('Body'),
    ctwaClid: field('CtwaClid'),
  };
  if (Object.values(data).every((value) => value === null)) return null;
  const label = data.headline ?? data.sourceType ?? 'ad';
  return structured(STRUCTURED_SCHEMAS.REFERRAL, data, `[arrived via ${label}]`);
}
