import 'server-only';
import { CONTROL_STATES, type ControlState } from '@ocso/domain';
import { z } from 'zod';
import { channelMark } from '@/components/workspace/lib/channel';
import { pickupSla, type SlaView } from '@/components/workspace/lib/sla';
import type { ChannelMarkView } from '../channels';
import { loadChannelKinds } from './channels';
import { api } from './client';
import { ApiError } from './errors';
import { notYetAvailable } from './pending';

export type { SlaView };

/* ───────────── Response schemas (packages/application/src/conversations/*) ───────────── */

const Ref = z.object({ id: z.string(), name: z.string() });
const State = z.enum(CONTROL_STATES as [ControlState, ...ControlState[]]);

export const INBOX_VIEWS = ['all', 'mine', 'waiting', 'ai', 'human', 'priority', 'resolved'] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export const ConversationSummarySchema = z.object({
  id: z.string(),
  displayId: z.string(),
  customer: z.object({ id: z.string(), name: z.string().nullable(), identity: z.string().nullable() }),
  channel: z.object({ id: z.string().nullable(), kind: z.string().nullable(), name: z.string().nullable() }),
  agent: z.object({ id: z.string(), name: z.string(), conversationType: z.string() }),
  controlState: State,
  priority: z.string(),
  assignedUser: Ref.nullable(),
  queue: Ref.nullable(),
  lastPreview: z.string().nullable(),
  lastInteractionAt: z.string(),
  waitingSince: z.string().nullable(),
  slaDueAt: z.string().nullable(),
  resolutionDueAt: z.string().nullable().default(null),
  tags: z.array(z.string()),
  handoff: z.object({ reason: z.string(), mode: z.string(), status: z.string() }).nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
  disposition: z.string().nullable().default(null),
  csat: z.number().nullable().default(null),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const InboxSchema = z.object({
  items: z.array(ConversationSummarySchema),
  counts: z.record(z.enum(INBOX_VIEWS), z.number()),
});
export type Inbox = z.infer<typeof InboxSchema>;

export const TagSuggestionsSchema = z.object({ items: z.array(z.object({ tag: z.string(), count: z.number() })) });
export type TagSuggestions = z.infer<typeof TagSuggestionsSchema>;

export const ConversationDetailSchema = z.object({
  id: z.string(),
  displayId: z.string(),
  type: z.string(),
  controlState: State,
  priority: z.string(),
  version: z.number(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  disposition: z.string().nullable(),
  tags: z.array(z.string()),
  waitingSince: z.string().nullable(),
  slaDueAt: z.string().nullable(),
  resolutionDueAt: z.string().nullable().default(null),
  customer: z.object({
    id: z.string(),
    name: z.string().nullable(),
    language: z.string().nullable(),
    attributes: z.record(z.string(), z.unknown()),
    identities: z.array(z.object({ kind: z.string(), value: z.string() })),
  }),
  channel: z.object({ id: z.string(), kind: z.string(), name: z.string() }).nullable(),
  agent: z.object({ id: z.string(), name: z.string(), conversationType: z.string(), status: z.string() }),
  promptVersion: z.object({ id: z.string(), version: z.number() }).nullable(),
  modelProfile: Ref.nullable(),
  queue: Ref.nullable(),
  assignedUser: Ref.nullable(),
  summary: z.object({ version: z.number(), text: z.string(), coversThroughSeq: z.number(), createdAt: z.string() }).nullable(),
  openHandoff: z
    .object({
      id: z.string(),
      status: z.string(),
      reasonText: z.string(),
      mode: z.string(),
      requestedAt: z.string(),
      agentSummary: z.string().nullable(),
      offerExpiresAt: z.string().nullable().default(null),
    })
    .nullable(),
  handover: z.object({ version: z.number(), text: z.string(), createdAt: z.string() }).nullable().default(null),
  resolvedBy: Ref.nullable().default(null),
  firstHumanResponseAt: z.string().nullable().default(null),
  /** The channel's customer-service window (length from its adapter); null for channels without one. */
  sessionWindow: z.object({ open: z.boolean(), closesAt: z.string().nullable(), hours: z.number().optional() }).nullable().default(null),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

const Media = z.object({
  mimeType: z.string(),
  sizeBytes: z.number().optional(),
  filename: z.string().optional(),
  status: z.string(),
  rejectionReason: z.string().optional(),
});
const url = z.string().optional();
export const PartSchema = z.union([
  z.object({ type: z.literal('TEXT'), text: z.string() }),
  z.object({ type: z.literal('IMAGE'), media: Media, caption: z.string().optional(), url }),
  z.object({ type: z.literal('AUDIO'), media: Media, durationMs: z.number().optional(), transcript: z.string().optional(), voiceNote: z.boolean().optional(), url }),
  z.object({ type: z.literal('VIDEO'), media: Media, caption: z.string().optional(), url }),
  z.object({ type: z.literal('DOCUMENT'), media: Media, caption: z.string().optional(), url }),
  z.object({ type: z.literal('LOCATION'), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional() }),
  z.object({
    type: z.literal('CONTACT'),
    contacts: z.array(z.object({ name: z.string(), phones: z.array(z.string()).default([]), emails: z.array(z.string()).default([]), organization: z.string().optional() })),
  }),
  z.object({ type: z.literal('STRUCTURED'), schema: z.string(), data: z.record(z.string(), z.unknown()), fallbackText: z.string().optional() }),
  z.object({ type: z.literal('TOOL_RESULT'), toolCallId: z.string(), toolName: z.string(), status: z.string(), summary: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ type: z.string() }),
]);
export type MessagePart = z.infer<typeof PartSchema>;

export const TimelineItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.string(),
    seq: z.number(),
    actorType: z.enum(['CUSTOMER', 'AGENT', 'HUMAN']),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    direction: z.string(),
    deliveryStatus: z.string(),
    deliveryError: z.string().nullable(),
    parts: z.array(PartSchema),
    turnId: z.string().nullable(),
    at: z.string(),
  }),
  z.object({ kind: z.literal('system'), id: z.string(), seq: z.number(), schema: z.string(), text: z.string(), data: z.record(z.string(), z.unknown()), at: z.string() }),
  z.object({ kind: z.literal('note'), id: z.string(), authorId: z.string(), authorName: z.string(), body: z.string(), passToAgent: z.boolean(), at: z.string() }),
  z.object({
    kind: z.literal('tool'),
    id: z.string(),
    toolName: z.string(),
    connectionName: z.string().nullable(),
    riskClass: z.string().nullable(),
    status: z.string(),
    actorType: z.string(),
    decisionReason: z.string().nullable(),
    confirmedByName: z.string().nullable(),
    latencyMs: z.number().nullable(),
    summary: z.unknown(),
    args: z.unknown().default(null),
    expiresAt: z.string().nullable().default(null),
    errorCategory: z.string().nullable().default(null),
    at: z.string(),
  }),
]);
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

export const WorkspaceToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  riskClass: z.string(),
  connection: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type WorkspaceTool = z.infer<typeof WorkspaceToolSchema>;

const ToolsSchema = z.object({
  available: z.array(WorkspaceToolSchema),
  pendingConfirmations: z.array(
    z.object({ id: z.string(), toolName: z.string(), args: z.unknown(), reason: z.string().nullable(), expiresAt: z.string().nullable(), requestedAt: z.string() }),
  ),
});
export type ConversationTools = z.infer<typeof ToolsSchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  externalRef: z.string().nullable(),
  language: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  identities: z.array(z.object({ kind: z.string(), display: z.string().nullable(), verified: z.boolean().default(false) })),
  conversations: z.array(z.object({ id: z.string(), controlState: State, openedAt: z.string(), lastPreview: z.string().nullable(), agentId: z.string() })),
});
export type CustomerProfile = z.infer<typeof CustomerSchema>;

export const CopilotSuggestionSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  text: z.string(),
  status: z.string(),
  basedOnSeq: z.number(),
  agentName: z.string(),
  basis: z.object({ historyMessages: z.number(), policyRefs: z.array(z.string()) }),
  style: z.string().nullable(),
  createdAt: z.string(),
});
export type CopilotSuggestion = z.infer<typeof CopilotSuggestionSchema>;

/** Copilot state for the composer: `unavailable` hides the block (not shipped / not permitted / off). */
export type CopilotState = { status: 'unavailable' } | { status: 'none' } | { status: 'ready'; suggestion: CopilotSuggestion };

const Option = z.object({ id: z.string(), name: z.string() });
export type Option = z.infer<typeof Option>;
const UserOption = z.object({ id: z.string(), name: z.string(), role: z.string(), status: z.string(), availability: z.string() });

/* ───────────── Loaders ───────────── */

export interface InboxQuery {
  view: InboxView;
  search?: string | undefined;
  agentId?: string | undefined;
  queueId?: string | undefined;
  tag?: string | undefined;
  limit?: number | undefined;
}

export function loadInbox(q: InboxQuery): Promise<Inbox> {
  const params = new URLSearchParams({ view: q.view, limit: String(q.limit ?? 50) });
  if (q.search) params.set('search', q.search);
  if (q.agentId) params.set('agentId', q.agentId);
  if (q.queueId) params.set('queueId', q.queueId);
  if (q.tag) params.set('tag', q.tag);
  return api.get(`/v1/conversations?${params.toString()}`, InboxSchema);
}

/** Most used tags on conversations this user can see (autocomplete), optionally by prefix. */
export function loadTagSuggestions(prefix?: string, limit = 10): Promise<TagSuggestions> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (prefix) params.set('prefix', prefix);
  return api.get(`/v1/conversations/tags?${params.toString()}`, TagSuggestionsSchema);
}

export function loadConversation(id: string): Promise<ConversationDetail> {
  return api.get(`/v1/conversations/${encodeURIComponent(id)}`, ConversationDetailSchema);
}

export function loadTimeline(id: string): Promise<TimelineItem[]> {
  return api.get(`/v1/conversations/${encodeURIComponent(id)}/timeline`, z.array(TimelineItemSchema));
}

export function loadConversationTools(id: string): Promise<ConversationTools> {
  return api.get(`/v1/conversations/${encodeURIComponent(id)}/tools`, ToolsSchema);
}

export function loadCustomer(id: string): Promise<CustomerProfile> {
  return api.get(`/v1/customers/${encodeURIComponent(id)}`, CustomerSchema);
}

/**
 * GET …/copilot/latest: 204 (none or stale) → none; an already inserted or
 * dismissed draft → none; 404/403/400/409 from the copilot routes → hidden.
 */
export async function loadCopilotLatest(id: string): Promise<CopilotState> {
  try {
    const suggestion = await api.get(`/v1/conversations/${encodeURIComponent(id)}/copilot/latest`, CopilotSuggestionSchema.optional());
    return suggestion && suggestion.status === 'READY' ? { status: 'ready', suggestion } : { status: 'none' };
  } catch (err) {
    if (err instanceof ApiError && [400, 403, 404, 409].includes(err.status)) return { status: 'unavailable' };
    throw err;
  }
}

/** Filter/transfer targets. Callers only ask when the role holds queues.read / agents.read / users.read. */
export function loadQueueOptions(): Promise<Option[]> {
  return api.get('/v1/queues', z.array(Option));
}

export function loadAgentOptions(): Promise<Option[]> {
  return api.get('/v1/agents', z.array(Option));
}

/** Active CS staff a lead may transfer to directly. */
export async function loadTransferUsers(): Promise<Option[]> {
  const users = await api.get('/v1/users', z.array(UserOption));
  return users.filter((u) => u.status === 'ACTIVE' && (u.role === 'CS_EXEC' || u.role === 'CS_LEAD')).map(({ id, name }) => ({ id, name }));
}

/* ───────────── Home (design/06) — built on the inbox views ───────────── */

export interface PickupRow {
  conversationId: string;
  customerName: string;
  /** Channel plus masked identifier, e.g. "whatsapp · +91 98•••41208". */
  customerRef: string;
  /** The channel kind's mark (from its descriptor). */
  channel: ChannelMarkView | null;
  agentName: string;
  reason: string;
  waitingSeconds: number;
  sla: SlaView | null;
}

export interface AssignmentRow {
  conversationId: string;
  customerName: string;
  topic: string;
  agentName: string;
  controlState: ControlState;
  lastTurnAt: string;
  sla: SlaView | null;
}

export interface ResolvedRow {
  conversationId: string;
  customerName: string;
  summary: string;
  resolvedAt: string;
  csat: number | null;
}

export interface ExecMetrics {
  assignedToMe: number;
  waitingForHuman: number;
  slaBreached: number;
  resolvedToday: number;
  firstResponseSeconds: number | null;
  csat7d: number | null;
}

const customerName = (c: ConversationSummary) => c.customer.name ?? c.customer.identity ?? 'Unknown customer';

export async function loadPickupQueue(): Promise<PickupRow[]> {
  const [{ items }, kinds] = await Promise.all([loadInbox({ view: 'waiting', limit: 20 }), loadChannelKinds()]);
  const now = Date.now();
  return items
    .map((c) => ({
      conversationId: c.id,
      customerName: customerName(c),
      customerRef: [c.channel.name ?? c.channel.kind?.toLowerCase(), c.customer.identity].filter(Boolean).join(' · '),
      channel: channelMark(kinds, c.channel.kind),
      agentName: c.agent.name,
      reason: c.handoff?.reason ?? c.lastPreview ?? '—',
      waitingSeconds: c.waitingSince ? Math.max(0, Math.round((now - Date.parse(c.waitingSince)) / 1000)) : 0,
      sla: pickupSla(c.controlState, c.waitingSince, c.slaDueAt, now),
    }))
    .sort((a, b) => b.waitingSeconds - a.waitingSeconds);
}

export async function loadMyAssignments(): Promise<AssignmentRow[]> {
  const { items } = await loadInbox({ view: 'mine', limit: 20 });
  const now = Date.now();
  return items.map((c) => ({
    conversationId: c.id,
    customerName: customerName(c),
    topic: c.lastPreview ?? c.handoff?.reason ?? '—',
    agentName: c.agent.name,
    controlState: c.controlState,
    lastTurnAt: c.lastInteractionAt,
    sla: pickupSla(c.controlState, c.waitingSince, c.slaDueAt, now),
  }));
}

export async function loadRecentlyResolved(): Promise<ResolvedRow[]> {
  const { items } = await loadInbox({ view: 'resolved', limit: 8 });
  return items.map((c) => ({
    conversationId: c.id,
    customerName: customerName(c),
    summary: c.disposition ?? c.lastPreview ?? '',
    resolvedAt: c.resolvedAt ?? c.lastInteractionAt,
    csat: c.csat,
  }));
}

export function loadExecMetrics(): Promise<ExecMetrics | null> {
  return notYetAvailable('GET /v1/analytics/me');
}
