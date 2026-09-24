import { z } from 'zod';

/**
 * The Bot Framework Activity fields OCSO reads (Bot Framework Activity
 * schema, Teams channel data). Loose objects: Teams adds fields over time.
 */

export const MAX_ACTIVITY_BYTES = 256 * 1024;

const Account = z.looseObject({
  id: z.string().min(1).max(512),
  name: z.string().max(512).optional().nullable(),
  aadObjectId: z.string().max(128).optional().nullable(),
});

export const TeamsActivity = z.looseObject({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(512).optional(),
  timestamp: z.string().optional(),
  serviceUrl: z.string().min(1).max(512),
  channelId: z.string().min(1).max(64),
  from: Account.optional(),
  recipient: Account.optional(),
  conversation: z
    .looseObject({
      id: z.string().min(1).max(1_024),
      conversationType: z.string().max(64).optional().nullable(),
      tenantId: z.string().max(128).optional().nullable(),
      isGroup: z.boolean().optional().nullable(),
    })
    .optional(),
  text: z.string().optional().nullable(),
  textFormat: z.string().optional().nullable(),
  value: z.unknown().optional(),
  replyToId: z.string().max(512).optional().nullable(),
  entities: z
    .array(
      z.looseObject({
        type: z.string(),
        text: z.string().optional().nullable(),
        mentioned: z.looseObject({ id: z.string(), name: z.string().optional().nullable() }).optional().nullable(),
      }),
    )
    .max(200)
    .optional()
    .nullable(),
  attachments: z.array(z.looseObject({ contentType: z.string().optional().nullable() })).max(100).optional().nullable(),
  channelData: z
    .looseObject({
      tenant: z.looseObject({ id: z.string().max(128) }).optional().nullable(),
    })
    .optional()
    .nullable(),
});
export type TeamsActivity = z.infer<typeof TeamsActivity>;

/** The JSON body, or null when it is empty, too large or not JSON. */
export function readJson(rawBody: Buffer | null): unknown {
  if (!rawBody?.byteLength || rawBody.byteLength > MAX_ACTIVITY_BYTES) return null;
  try {
    return JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** What verification needs from the body before the token is checked: the activity's channel and service URL. */
export function readActivityEnvelope(rawBody: Buffer | null): { serviceUrl: string; channelId: string } | null {
  const parsed = z.looseObject({ serviceUrl: z.string().min(1).max(512), channelId: z.string().min(1).max(64) }).safeParse(readJson(rawBody));
  return parsed.success ? { serviceUrl: parsed.data.serviceUrl, channelId: parsed.data.channelId } : null;
}
