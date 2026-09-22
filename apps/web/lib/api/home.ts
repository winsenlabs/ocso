import 'server-only';
import { z } from 'zod';
import { api } from './client';
import { PrivilegedChangeSchema, UptimeSchema } from './telemetry';

/**
 * Role-aware home (GET /v1/home, packages/application/src/analytics/home*.ts).
 * The API returns exactly one surface for the caller's role: execs never get
 * technical telemetry, Tech Admins never get conversation content.
 */

const n = z.number();
const nn = z.number().nullable();
const s = z.string();
const sn = z.string().nullable();
const Defs = z.record(z.string(), z.string()).default({});

const AdminSchema = z.object({
  uptime: UptimeSchema,
  tiles: z.object({
    healthyWorkers: z.object({ healthy: n, max: n, minWarm: n }),
    activeConversations: n,
    ttftP95Ms: nn,
    tokensToday: n,
    openIncidents: n,
  }),
  incidents: z.object({
    open: n,
    critical: n,
    items: z.array(z.object({ id: s, title: s, severity: s, source: s, status: s, value: sn, openedAt: s, lastSeenAt: s, occurrences: n })),
  }),
  capacity: z.object({ slotsUsed: n, slotsTotal: n, utilization: nn, queueDepth: n, oldestAgeSeconds: nn, warmFloor: n, ceiling: n }),
  connections: z.object({
    mcp: z.object({ servers: n, tools: n, degraded: n }),
    providers: z.object({ providers: n, profiles: n, degraded: n }),
    channels: z.object({ channels: n, active: n, failedDeliveries1h: n }),
  }),
  recentChanges: z.array(PrivilegedChangeSchema),
  definitions: Defs,
});
export type AdminHomeData = z.infer<typeof AdminSchema>;
export type AdminIncident = AdminHomeData['incidents']['items'][number];

const AgentCardSchema = z.object({
  agentId: s,
  name: s,
  conversationType: s,
  status: s,
  promptVersion: nn,
  channels: z.array(z.object({ kind: s, name: s })),
  conversations: n,
  containmentRate: nn,
  escalationRate: nn,
  csat: nn,
  csatResponses: n,
  openConversations: n,
  waitingForHuman: n,
  slaBreaches: n,
  openAlerts: n,
});
export type HomeAgentCard = z.infer<typeof AgentCardSchema>;

const QueueRowSchema = z.object({
  queueId: s,
  name: s,
  mode: s,
  waiting: n,
  oldestWaitingSince: sn,
  onShift: n,
  members: n,
  breaches: n,
  slaBreachesInWindow: n,
  avgWaitSeconds: nn,
  pickedUp: n,
  state: z.enum(['ok', 'watch', 'understaffed']),
});
export type HomeQueueRow = z.infer<typeof QueueRowSchema>;

const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt_corrections'), agentId: s, agentName: s, open: n, staged: n }),
  z.object({ kind: z.literal('understaffed_queue'), queueId: s, queueName: s, waiting: n, onShift: n, members: n }),
  z.object({ kind: z.literal('escalation_spike'), agentId: s, agentName: s, escalationRate: n, previousRate: n, conversations: n }),
]);
export type LeadDecision = z.infer<typeof DecisionSchema>;

const LeadSchema = z.object({
  window: z.object({ from: s, to: s, days: n }),
  tiles: z.object({
    conversations: n,
    containmentRate: nn,
    escalationRate: nn,
    slaBreaches: n,
    csat: z.object({ average: nn, responses: n }).loose(),
    correctionsOpen: n,
    correctionsStaged: n,
  }),
  agents: z.array(AgentCardSchema),
  queues: z.array(QueueRowSchema),
  decisions: z.array(DecisionSchema),
  escalationReasons: z.array(z.object({ reasonCode: s, trigger: s, count: n, example: sn })),
  definitions: Defs,
});
export type LeadHomeData = z.infer<typeof LeadSchema>;

const ForYouSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), conversationId: s, customerName: sn, priority: s, waitingSince: sn }),
  z.object({ kind: z.literal('urgent_pickup'), conversationId: s, customerName: sn, priority: s, waitingSince: sn, reason: sn }),
  z.object({ kind: z.literal('alert'), alertId: s, title: s, severity: s, openedAt: s }),
]);
export type ForYouItem = z.infer<typeof ForYouSchema>;

/** Exec tiles, shift and "for you"; the pickup/assigned/resolved tables come from lib/api/conversations. */
const ExecSchema = z.object({
  tiles: z.object({
    assignedToMe: n,
    waitingForHuman: n,
    slaBreached: n,
    resolvedToday: n,
    myFirstResponseMedianSeconds: nn,
    myCsat7d: z.object({ average: nn, responses: n }),
  }),
  shift: z.object({
    availability: s,
    maxConcurrent: n,
    activeConversations: n,
    queues: z.array(z.object({ id: s, name: s })),
    languages: z.array(s),
    skills: z.array(s),
  }),
  forYou: z.array(ForYouSchema),
  definitions: Defs,
});
export type ExecHomeData = z.infer<typeof ExecSchema>;

const User = z.object({ id: s, name: s });

export const HomeSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('PLATFORM_TECH_ADMIN'), generatedAt: s, user: User, admin: AdminSchema }),
  z.object({ role: z.literal('CS_LEAD'), generatedAt: s, user: User, lead: LeadSchema }),
  z.object({ role: z.literal('CS_EXEC'), generatedAt: s, user: User, exec: ExecSchema }),
]);
export type HomeData = z.infer<typeof HomeSchema>;

export const loadHome = () => api.get('/v1/home', HomeSchema);
