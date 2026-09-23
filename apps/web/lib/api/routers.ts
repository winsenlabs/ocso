import 'server-only';
import { RouterDefinitionSchema } from '@ocso/domain';
import { z } from 'zod';
import { ObjectApprovalStateSchema, ProposedSchema } from '@/components/approvals/lib/schemas';
import { api } from './client';

/* ───────────── Routers (apps/api routers.controller.ts, packages/application routing/routers.ts; PM/research/11 §5.7) ───────────── */

const enc = encodeURIComponent;
const Problem = z.object({ code: z.string(), message: z.string() });

export const RouterSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']),
  kind: z.enum(['PASS_THROUGH', 'MENU', 'MODEL', 'MIXED']).nullable(),
  activeVersion: z.object({ id: z.string(), version: z.number() }).nullable(),
  channels: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  draftUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RouterSummary = z.infer<typeof RouterSummarySchema>;

export const RouterDetailSchema = RouterSummarySchema.extend({
  draft: z.object({ definition: RouterDefinitionSchema, updatedAt: z.string(), problems: z.array(Problem) }).nullable(),
  activeDefinition: RouterDefinitionSchema.nullable(),
  versions: z.array(z.object({ id: z.string(), version: z.number(), reason: z.string(), createdAt: z.string(), createdBy: z.string().nullable() })),
  latestVersionId: z.string().nullable(),
  approval: ObjectApprovalStateSchema.nullable().default(null),
});
export type RouterDetail = z.infer<typeof RouterDetailSchema>;

const TraceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('customer'), text: z.string() }),
  z.object({ kind: z.literal('router'), stepId: z.string(), text: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })).nullable() }),
  z.object({
    kind: z.literal('classified'),
    stepId: z.string(),
    label: z.string().nullable(),
    confidence: z.number(),
    followUp: z.string().nullable(),
    source: z.enum(['answer', 'model', 'none', 'error']),
    error: z.string().optional(),
  }),
  z.object({ kind: z.literal('decided'), queueId: z.string(), queueName: z.string().nullable(), agentName: z.string().nullable(), outcome: z.string(), ruleIndex: z.number().nullable(), reason: z.string() }),
  z.object({ kind: z.literal('continued'), outcome: z.string() }),
  z.object({ kind: z.literal('new_conversation') }),
  z.object({ kind: z.literal('waiting'), text: z.string() }),
]);
export type SimulationTrace = z.infer<typeof TraceSchema>;
export const SimulationSchema = z.object({ trace: z.array(TraceSchema), decision: TraceSchema.nullable() });
export type Simulation = z.infer<typeof SimulationSchema>;

export const AgentReachSchema = z.array(
  z.object({
    channel: z.object({ id: z.string(), name: z.string(), kind: z.string(), status: z.string() }),
    router: z.object({ id: z.string(), name: z.string() }),
    queue: z.object({ id: z.string(), name: z.string() }),
  }),
);
export type AgentReach = z.infer<typeof AgentReachSchema>;

/** A write that became a proposal (202) — or was applied (a draft). */
const Maybe = <S extends z.ZodType>(applied: S) => z.union([ProposedSchema.passthrough(), applied]);

export const listRouters = () => api.get('/v1/routers', z.array(RouterSummarySchema));
export const getRouter = (id: string) => api.get(`/v1/routers/${enc(id)}`, RouterDetailSchema);
export const loadAgentReach = (agentId: string) => api.get(`/v1/routers/reach?agentId=${enc(agentId)}`, AgentReachSchema);

export const createRouter = (body: { name: string; description: string; definition: unknown }) => api.post('/v1/routers', body, z.object({ id: z.string() }));
export const saveRouterDraft = (id: string, body: { definition: unknown; name?: string | undefined; description?: string | undefined }) =>
  api.put(`/v1/routers/${enc(id)}/draft`, body, z.object({ id: z.string() }));
export const freezeRouterVersion = (id: string, reason: string) => api.post(`/v1/routers/${enc(id)}/versions`, { reason }, z.object({ id: z.string(), version: z.number() }));
export const activateRouter = (id: string, body: { versionId: string; approval?: unknown }) => api.post(`/v1/routers/${enc(id)}/activate`, body, ProposedSchema);
export const disableRouter = (id: string) => api.command('POST', `/v1/routers/${enc(id)}/disable`);
export const setRouterChannels = (id: string, body: { channelIds: string[]; approval?: unknown }) =>
  api.put(`/v1/routers/${enc(id)}/channels`, body, Maybe(z.object({ detached: z.array(z.string()), attached: z.array(z.string()) })));
export const updateRouter = (id: string, body: { name?: string | undefined; description?: string | undefined; approval?: unknown }) => api.patch(`/v1/routers/${enc(id)}`, body, Maybe(z.object({ id: z.string() })));
export const deleteRouter = (id: string, body: { approval?: unknown }) => api.delete(`/v1/routers/${enc(id)}`, body, ProposedSchema);
export const simulateRouter = (id: string, body: { messages: string[]; versionId?: string | undefined; returning?: boolean | undefined; customer?: { language?: string | undefined } | undefined }) =>
  api.post(`/v1/routers/${enc(id)}/simulate`, body, SimulationSchema);
