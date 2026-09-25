import type { UIMessage } from 'ai';
import { z } from 'zod';

/**
 * Ask OCSO message contract (docs/archive/specs/12, design/05). The API streams AI SDK UI
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

/**
 * UNKNOWN: a confirm whose outcome is not known yet (the request outlived its wait, or the route outlived its
 * bound and may still apply). The drawer says so, links the object, and re-reads the card until it settles.
 */
export const ActionStatusSchema = z.enum(['PENDING', 'EXECUTED', 'SUBMITTED', 'REJECTED', 'EXPIRED', 'FAILED', 'STALE', 'UNKNOWN']);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

const ChangeSchema = z.object({ label: z.string(), before: z.string().nullable(), after: z.string() });

/** One credential field on a card. `generate`: left blank, OCSO generates the value. */
export const CredentialFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  hint: z.string().nullish(),
  required: z.boolean().default(false),
  generate: z.boolean().nullish(),
});
export type CredentialField = z.infer<typeof CredentialFieldSchema>;

/**
 * A confirmation card (PM/research/12 §5): built by the server for every write
 * the agent wants to make. Nothing runs until this user confirms it; governed
 * changes are submitted to a checker instead of applied.
 */
export const ActionCardSchema = z.object({
  id: z.string(),
  tool: z.string(),
  title: z.string(),
  summary: z.string().default(''),
  kind: z.enum(['direct', 'stop', 'governed']),
  object: z.object({ kind: z.string(), id: z.string(), name: z.string(), href: z.string().nullish() }).nullish(),
  changes: z.array(ChangeSchema).default([]),
  warnings: z.array(z.string()).default([]),
  approval: z
    .object({
      objectKind: z.string(),
      checkers: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), suggested: z.boolean() })),
      noEligibleChecker: z.boolean(),
      uiHref: z.string().nullish(),
    })
    .nullish(),
  /**
   * Credentials the user types into the card's own password fields (PM/research/12 §9): names only, never values.
   * The model never sees them; the values go with this user's confirm and are not kept anywhere.
   */
  credentials: z.array(CredentialFieldSchema).nullish(),
  expiresAt: z.string(),
  status: ActionStatusSchema.default('PENDING'),
  result: z.object({ message: z.string(), href: z.string().nullish(), proposalId: z.string().nullish() }).nullish(),
});
export type ActionCardData = z.infer<typeof ActionCardSchema>;

/**
 * A secret the confirmed route generated (e.g. a web chat backend key). It arrives once, on the confirm response
 * only: never on the stored card, never in the thread history.
 */
export const RevealedSecretSchema = z.object({ key: z.string(), label: z.string(), value: z.string().min(1) });
export type RevealedSecret = z.infer<typeof RevealedSecretSchema>;

/** The earlier proposal shape (before cards): still rendered for old threads. */
export const PendingActionSchema = z.object({
  id: z.string(),
  tool: z.string(),
  risk: z.string(),
  description: z.string(),
  expiresAt: z.string(),
  changes: z.array(ChangeSchema).optional(),
  /** Present on history reads: where the action stands now. Live proposals are pending. */
  status: ActionStatusSchema.optional(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

/** A card as it arrives on the stream or in history: the card shape, or the earlier proposal shape. */
export const ActionPartSchema = z.union([ActionCardSchema, PendingActionSchema]);
export type ActionPart = z.infer<typeof ActionPartSchema>;

/** One card shape for the renderer; a legacy proposal becomes a direct card. */
export function toActionCard(part: ActionPart): ActionCardData {
  if ('kind' in part) return part;
  return {
    id: part.id,
    tool: part.tool,
    title: part.description,
    summary: '',
    kind: 'direct',
    changes: part.changes ?? [],
    warnings: [],
    expiresAt: part.expiresAt,
    status: part.status ?? 'PENDING',
  };
}

/** A "What can you do?" chip: a task this user's permissions cover (GET /v1/internal-agent/capabilities/suggestions). */
export const SuggestionSchema = z.object({ label: z.string().min(1), prompt: z.string().min(1) });
export type Suggestion = z.infer<typeof SuggestionSchema>;

/** One area of the capability catalog this user can reach (GET /v1/internal-agent/capabilities/suggestions `areas`). */
export const CapabilityAreaSchema = z.object({ area: z.string(), label: z.string(), reads: z.number().int().min(0), writes: z.number().int().min(0) });
export type CapabilityArea = z.infer<typeof CapabilityAreaSchema>;

export const StepSchema = z.object({ label: z.string() });
export const DeniedSchema = z.object({ message: z.string() });
export const ThreadRefSchema = z.object({ threadId: z.string() });

export const dataPartSchemas = {
  step: StepSchema,
  links: z.array(ObjectLinkSchema),
  table: MiniTableSchema,
  action: ActionPartSchema,
  denied: DeniedSchema,
  thread: ThreadRefSchema,
};

export type AskOcsoData = {
  step: z.infer<typeof StepSchema>;
  links: ObjectLink[];
  table: MiniTableData;
  action: ActionPart;
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
  /** Where it was asked: null for the drawer, else the chat channel kind (`slack`, `ms_teams`). */
  surface: z.string().nullish(),
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
  /** "What can you do?" chips for this user's role; null when the API has none (the drawer falls back to its own). */
  suggestions: z.array(SuggestionSchema).nullable().default(null),
  /** The "What can you do?" answer, per catalog area for this user's role; null when the API sent none (the model answers). */
  areas: z.array(CapabilityAreaSchema).nullable().default(null),
  /** The deployment's Ask OCSO writes switch: off, the drawer offers reads only and says changes are turned off. */
  writesOn: z.boolean().default(true),
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
