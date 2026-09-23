import type { UIMessage } from 'ai';
import { z } from 'zod';

/**
 * Ask OCSO message contract (docs/12, design/05). The API streams AI SDK UI
 * message chunks: text plus typed `data-*` parts. These schemas validate
 * every data part at the browser boundary and type the chat messages.
 */

export const ObjectLinkSchema = z.object({
  label: z.string(),
  detail: z.string().nullish(),
  href: z.string(),
  status: z.enum(['ok', 'warn', 'danger']).nullish(),
});
export type ObjectLink = z.infer<typeof ObjectLinkSchema>;

export const MiniTableSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
});
export type MiniTableData = z.infer<typeof MiniTableSchema>;

export const ActionStatusSchema = z.enum(['PENDING', 'EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED']);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** A write the agent proposed; nothing changes until the same user confirms it. */
export const PendingActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  risk: z.string(),
  description: z.string(),
  expiresAt: z.string(),
  changes: z.array(z.object({ label: z.string(), before: z.string().nullable(), after: z.string() })).optional(),
  /** Present on history reads: where the action stands now. Live proposals are pending. */
  status: ActionStatusSchema.optional(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const StepSchema = z.object({ label: z.string() });
export const DeniedSchema = z.object({ message: z.string() });
export const ThreadRefSchema = z.object({ threadId: z.string() });

export const dataPartSchemas = {
  step: StepSchema,
  links: z.array(ObjectLinkSchema),
  table: MiniTableSchema,
  action: PendingActionSchema,
  denied: DeniedSchema,
  thread: ThreadRefSchema,
};

export type AskOcsoData = {
  step: z.infer<typeof StepSchema>;
  links: ObjectLink[];
  table: MiniTableData;
  action: PendingAction;
  denied: z.infer<typeof DeniedSchema>;
  thread: z.infer<typeof ThreadRefSchema>;
};

export type AskOcsoMessage = UIMessage<unknown, AskOcsoData>;
export type AskOcsoPart = AskOcsoMessage['parts'][number];

/** One entry of the thread history list (GET /v1/internal-agent/threads). */
export const ThreadSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

/** A model profile a Tech admin can pick for Ask OCSO. */
export const ProfileOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  providerName: z.string().nullable(),
});
export type ProfileOption = z.infer<typeof ProfileOptionSchema>;

/** GET /api/internal-agent: what the drawer needs when it opens. */
export const DrawerStateSchema = z.object({
  configured: z.boolean(),
  threads: z.array(ThreadSummarySchema),
  /** Only when not configured and the user may configure it. */
  profiles: z.array(ProfileOptionSchema).nullable(),
});
export type DrawerState = z.infer<typeof DrawerStateSchema>;

/** GET /api/internal-agent/threads/:id */
export interface ThreadHistory {
  threadId: string;
  messages: AskOcsoMessage[];
}

/** Shape check for the thread route; parts were validated when the route built them. */
export const ThreadHistorySchema = z.object({
  threadId: z.string(),
  messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), parts: z.array(z.object({ type: z.string() }).loose()) })),
});
