import { z } from 'zod';

/** What `render` produces and `send` posts: plain mrkdwn text, or Block Kit blocks with their notification text. */

const Block = z.looseObject({ type: z.string() });

export const SlackOutboundPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('blocks'), text: z.string().min(1), blocks: z.array(Block).min(1).max(50) }),
]);
export type SlackOutboundPayload = z.infer<typeof SlackOutboundPayload>;
