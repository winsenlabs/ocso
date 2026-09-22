import type { IdentityUpdate } from '../../contract/types.js';
import { normalizeBsuid, normalizePhone, WHATSAPP_IDENTITY } from '../identity.js';
import { unixSecondsToDate, UserIdUpdateValue, WaMessageBase, WaSystem } from './schema.js';

/**
 * Identity rotation events:
 * - `user_id_update` change field: BSUID (and parent BSUID) previous -> current.
 * - `system` messages: `user_changed_number` (phone) / `user_changed_user_id` (BSUID).
 */

type Pair = { previous?: string | undefined; current?: string | undefined } | undefined;

function bsuidUpdate(
  kind: string,
  pair: Pair,
  alternates: IdentityUpdate['alternateIdentities'],
  channelAccountId: string | undefined,
  occurredAt: Date,
): IdentityUpdate | null {
  const previousValue = normalizeBsuid(pair?.previous);
  const currentValue = normalizeBsuid(pair?.current);
  if (!previousValue || !currentValue || previousValue === currentValue) return null;
  return { identityKind: kind, previousValue, currentValue, alternateIdentities: alternates, channelAccountId, occurredAt };
}

export function identityUpdatesFromChange(value: unknown, now: () => Date): IdentityUpdate[] | null {
  const parsed = UserIdUpdateValue.safeParse(value);
  if (!parsed.success) return null;
  const channelAccountId = parsed.data.metadata?.phone_number_id;
  return parsed.data.user_id_update.flatMap((update) => {
    const phone = normalizePhone(update.wa_id);
    const alternates = phone ? [{ kind: WHATSAPP_IDENTITY.PHONE, value: phone }] : [];
    const occurredAt = unixSecondsToDate(update.timestamp, now);
    return [
      bsuidUpdate(WHATSAPP_IDENTITY.BSUID, update.user_id, alternates, channelAccountId, occurredAt),
      bsuidUpdate(WHATSAPP_IDENTITY.PARENT_BSUID, update.parent_user_id, alternates, channelAccountId, occurredAt),
    ].filter((u): u is IdentityUpdate => u !== null);
  });
}

export function identityUpdateFromSystemMessage(
  raw: unknown,
  channelAccountId: string,
  now: () => Date,
): IdentityUpdate | null {
  const base = WaMessageBase.safeParse(raw);
  const system = WaSystem.safeParse(base.success ? base.data['system'] : undefined);
  if (!base.success || !system.success) return null;
  const occurredAt = unixSecondsToDate(base.data.timestamp, now);
  if (system.data.type === 'user_changed_number') {
    const previousValue = normalizePhone(base.data.from);
    const currentValue = normalizePhone(system.data.wa_id);
    if (!previousValue || !currentValue || previousValue === currentValue) return null;
    const bsuid = normalizeBsuid(system.data.user_id ?? base.data.from_user_id);
    const alternates = bsuid ? [{ kind: WHATSAPP_IDENTITY.BSUID, value: bsuid }] : [];
    return {
      identityKind: WHATSAPP_IDENTITY.PHONE,
      previousValue,
      currentValue,
      alternateIdentities: alternates,
      channelAccountId,
      occurredAt,
    };
  }
  if (system.data.type === 'user_changed_user_id') {
    const phone = normalizePhone(base.data.from ?? system.data.wa_id);
    const alternates = phone ? [{ kind: WHATSAPP_IDENTITY.PHONE, value: phone }] : [];
    const pair = { previous: base.data.from_user_id, current: system.data.user_id };
    return bsuidUpdate(WHATSAPP_IDENTITY.BSUID, pair, alternates, channelAccountId, occurredAt);
  }
  return null;
}
