import { z } from 'zod';
import { InteractionPart } from './parts.js';

/** Who produced an interaction (docs/03 §2). */
export const ActorType = z.enum(['CUSTOMER', 'AGENT', 'HUMAN', 'SYSTEM', 'TOOL', 'ROUTER']);
export type ActorType = z.infer<typeof ActorType>;

export const Direction = z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']);
export type Direction = z.infer<typeof Direction>;

/** CUSTOMER interactions may be rendered to channels; INTERNAL never are. */
export const Visibility = z.enum(['CUSTOMER', 'INTERNAL']);
export type Visibility = z.infer<typeof Visibility>;

export const DeliveryStatus = z.enum(['NOT_APPLICABLE', 'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** Ordering of delivery statuses; a status update never moves backwards. */
const DELIVERY_RANK: Readonly<Record<DeliveryStatus, number>> = {
  NOT_APPLICABLE: 0,
  PENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 5,
};

export function nextDeliveryStatus(current: DeliveryStatus, incoming: DeliveryStatus): DeliveryStatus {
  if (current === 'FAILED') return current;
  if (incoming === 'FAILED') return incoming;
  return DELIVERY_RANK[incoming] > DELIVERY_RANK[current] ? incoming : current;
}

export const Interaction = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Monotonic per conversation; defines turn ordering. */
  seq: z.number().int().positive(),
  actorType: ActorType,
  actorId: z.string().nullable(),
  direction: Direction,
  visibility: Visibility,
  parts: z.array(InteractionPart).min(1),
  correlationId: z.string(),
  /** External message id or client-supplied key; unique for inbound dedupe. */
  idempotencyKey: z.string().nullable(),
  deliveryStatus: DeliveryStatus,
  turnId: z.string().nullable(),
  createdAt: z.string(),
});
export type Interaction = z.infer<typeof Interaction>;

/** Validated input for creating a new interaction (before id/seq exist). */
export const NewInteraction = Interaction.pick({
  actorType: true,
  actorId: true,
  direction: true,
  visibility: true,
  parts: true,
  idempotencyKey: true,
}).extend({
  correlationId: z.string().optional(),
});
export type NewInteraction = z.infer<typeof NewInteraction>;
