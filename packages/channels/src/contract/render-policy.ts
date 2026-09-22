import { isCustomerRenderable, type InteractionPart } from '@ocso/domain';
import type { ChannelCapabilities } from './types.js';

/**
 * Rendering policy (docs/07 §5): only customer-safe parts the channel supports
 * ever reach an adapter's render(). Tool results, internal notes, policy
 * metadata and unsupported part types are dropped here, in one place.
 */
export function customerSafeParts(
  parts: readonly InteractionPart[],
  capabilities: ChannelCapabilities,
): { parts: InteractionPart[]; dropped: InteractionPart['type'][] } {
  const kept: InteractionPart[] = [];
  const dropped: InteractionPart['type'][] = [];
  for (const part of parts) {
    if (isCustomerRenderable(part) && capabilities.outboundParts.includes(part.type)) kept.push(part);
    else dropped.push(part.type);
  }
  return { parts: kept, dropped };
}

/** True when a free-form (non-template) message may be sent now. */
export function withinSessionWindow(
  capabilities: ChannelCapabilities,
  lastInboundAt: Date | null,
  now: Date,
): boolean {
  if (capabilities.sessionWindowHours === null) return true;
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < capabilities.sessionWindowHours * 3_600_000;
}
