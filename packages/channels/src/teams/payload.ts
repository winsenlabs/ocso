import { z } from 'zod';

/** What `render` produces and `send` posts: Teams markdown text, or an Adaptive Card with a notification summary. */

export const TeamsOutboundPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('card'), summary: z.string(), card: z.looseObject({ type: z.literal('AdaptiveCard') }) }),
]);
export type TeamsOutboundPayload = z.infer<typeof TeamsOutboundPayload>;
