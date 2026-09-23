import { z } from 'zod';
import type { InteractionPart } from '@ocso/domain';
import { clip, nonEmpty } from '../../common/text.js';
import type { WaMessage } from './schema.js';

/** Non-media normalizers: text, location, contacts. */

const MAX_CONTACTS = 20;

const WaText = z.object({ body: z.string() });

export function normalizeText(message: WaMessage): InteractionPart[] | null {
  const parsed = WaText.safeParse(message['text']);
  const body = parsed.success ? parsed.data.body : '';
  return body.trim() ? [{ type: 'TEXT', text: clip(body, 32_000) }] : null;
}

const WaLocation = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  name: z.string().optional(),
  address: z.string().optional(),
});

export function normalizeLocation(message: WaMessage): InteractionPart[] | null {
  const parsed = WaLocation.safeParse(message['location']);
  if (!parsed.success) return null;
  const { latitude, longitude } = parsed.data;
  const name = nonEmpty(parsed.data.name);
  const address = nonEmpty(parsed.data.address);
  return [
    {
      type: 'LOCATION',
      latitude,
      longitude,
      ...(name ? { name: clip(name, 500) } : {}),
      ...(address ? { address: clip(address, 1_000) } : {}),
    },
  ];
}

const WaContactCard = z.object({
  name: z
    .object({
      formatted_name: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
    })
    .optional(),
  phones: z.array(z.object({ phone: z.string().optional(), wa_id: z.string().optional() })).default([]),
  emails: z.array(z.object({ email: z.string().optional() })).default([]),
  org: z.object({ company: z.string().optional() }).optional(),
});
type WaContactCard = z.infer<typeof WaContactCard>;

function cardName(card: WaContactCard): string {
  const formatted = nonEmpty(card.name?.formatted_name);
  const joined = nonEmpty([card.name?.first_name, card.name?.last_name].filter(Boolean).join(' '));
  return clip(formatted ?? joined ?? nonEmpty(card.phones[0]?.phone) ?? 'Unknown contact', 500);
}

function toContactCard(card: WaContactCard) {
  const organization = nonEmpty(card.org?.company);
  return {
    name: cardName(card),
    phones: card.phones
      .map((p) => nonEmpty(p.phone) ?? nonEmpty(p.wa_id))
      .filter((p): p is string => Boolean(p))
      .map((p) => clip(p, 64)),
    emails: card.emails
      .map((e) => nonEmpty(e.email))
      .filter((e): e is string => Boolean(e))
      .map((e) => clip(e, 320)),
    ...(organization ? { organization: clip(organization, 500) } : {}),
  };
}

/** Shared contact cards are kept (the Chat SDK adapter drops them — ADR-007). */
export function normalizeContacts(message: WaMessage): InteractionPart[] | null {
  const parsed = z.array(WaContactCard).min(1).safeParse(message['contacts']);
  if (!parsed.success) return null;
  return [{ type: 'CONTACT', contacts: parsed.data.slice(0, MAX_CONTACTS).map(toContactCard) }];
}
