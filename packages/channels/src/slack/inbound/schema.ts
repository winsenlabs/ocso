import { z } from 'zod';

/**
 * The parts of Slack's Events API and interactivity payloads OCSO reads
 * (api.slack.com/apis/events-api, api.slack.com/reference/interaction-payloads/block-actions).
 * Loose objects: Slack adds fields freely; unknown shapes are ignored, never thrown.
 */

const Id = z.string().min(1).max(64);

export const SlackUrlVerification = z.looseObject({ type: z.literal('url_verification'), challenge: z.string() });

export const SlackMessageEvent = z.looseObject({
  type: z.string(),
  subtype: z.string().optional(),
  user: Id.optional(),
  bot_id: z.string().optional(),
  bot_profile: z.unknown().optional(),
  app_id: z.string().optional(),
  text: z.string().max(100_000).optional(),
  ts: z.string().regex(/^\d{1,12}\.\d{1,9}$/).optional(),
  thread_ts: z.string().regex(/^\d{1,12}\.\d{1,9}$/).optional(),
  channel: Id.optional(),
  channel_type: z.string().optional(),
  team: Id.optional(),
  user_team: Id.optional(),
  edited: z.unknown().optional(),
  hidden: z.boolean().optional(),
  user_profile: z
    .looseObject({ display_name: z.string().optional(), real_name: z.string().optional(), name: z.string().optional() })
    .optional(),
});
export type SlackMessageEvent = z.infer<typeof SlackMessageEvent>;

export const SlackEventCallback = z.looseObject({
  type: z.literal('event_callback'),
  team_id: Id.optional(),
  api_app_id: z.string().optional(),
  event_id: z.string().min(1).max(128),
  event_time: z.number().optional(),
  event: z.looseObject({ type: z.string() }),
  authorizations: z.array(z.looseObject({ team_id: z.string().nullish(), user_id: z.string().nullish(), is_bot: z.boolean().optional() })).optional(),
});
export type SlackEventCallback = z.infer<typeof SlackEventCallback>;

export const SlackBlockAction = z.looseObject({
  type: z.string(),
  action_id: z.string().min(1).max(255),
  block_id: z.string().optional(),
  value: z.string().max(2_000).optional(),
  text: z.looseObject({ text: z.string() }).optional(),
  action_ts: z.string().regex(/^\d{1,12}\.\d{1,9}$/).optional(),
});

export const SlackBlockActionsPayload = z.looseObject({
  type: z.literal('block_actions'),
  team: z.looseObject({ id: Id }).nullish(),
  user: z.looseObject({ id: Id, team_id: Id.optional(), name: z.string().optional(), username: z.string().optional() }),
  api_app_id: z.string().optional(),
  channel: z.looseObject({ id: Id }).optional(),
  container: z.looseObject({ type: z.string(), channel_id: Id.optional(), message_ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  message: z.looseObject({ ts: z.string().optional(), thread_ts: z.string().optional() }).optional(),
  actions: z.array(SlackBlockAction).min(1).max(25),
});
export type SlackBlockActionsPayload = z.infer<typeof SlackBlockActionsPayload>;
