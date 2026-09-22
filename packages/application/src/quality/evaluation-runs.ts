import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { evaluationResults, evaluationRuns, promptVersions, users, uuidv7, virtualAgents, type Db } from '@ocso/db';
import { BUSINESS_COMPONENT_KEYS, type BusinessComponentKey } from '@ocso/prompt-compiler';
import type { QueueAdapter } from '@ocso/queue';
import { z } from 'zod';
import { PromptService } from '../agents/prompt-versions.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

export const EVALUATION_TOPIC = 'evaluation.run' as const;

export const EvaluationRunInput = z
  .object({
    agentId: z.uuid(),
    /** DRAFT = the agent's current prompt draft; COMPONENTS = explicit components merged over the active version. */
    source: z.enum(['DRAFT', 'COMPONENTS']).default('DRAFT'),
    components: z.partialRecord(z.enum(BUSINESS_COMPONENT_KEYS), z.string().max(20_000)).optional(),
    caseCount: z.number().int().min(1).max(200).default(40),
  })
  .refine((v) => v.source === 'DRAFT' || v.components, 'components are required when source is COMPONENTS');
export type EvaluationRunInput = z.infer<typeof EvaluationRunInput>;

export const EvaluationRunQuery = z.object({ agentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(20) });
export type EvaluationRunQuery = z.infer<typeof EvaluationRunQuery>;
export const EvaluationResultsQuery = z.object({
  changedOnly: z.stringbool().default(false),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EvaluationResultsQuery = z.infer<typeof EvaluationResultsQuery>;

export type EvaluationRunRow = typeof evaluationRuns.$inferSelect;
export type EvaluationRunView = Omit<EvaluationRunRow, 'createdAt' | 'completedAt'> & {
  createdAt: string;
  completedAt: string | null;
  createdByName: string | null;
  baselineVersion: number | null;
  summaryDefinition: string;
};

export const EVALUATION_SUMMARY_DEFINITION =
  "Replay without side effects: for each case, the candidate prompt answers the same customer turn with the same history; tools are never executed (intended calls are recorded). changed = the set of intended (non-built-in) tool calls differs from the baseline turn's first step, or handoff behavior differs, or — when the candidate calls no tool — the normalized reply text differs from the baseline reply. Flags: handoff_requested, handoff_differs, tool_call_differs, empty_reply, error (the model call failed).";

/** Replay evaluation runs of a candidate prompt (design/02 Versions tab). The run itself is executed by the worker (topic evaluation.run). */
export class EvaluationRunService {
  constructor(
    private readonly db: Db,
    private readonly queue: QueueAdapter,
  ) {}

  async create(actor: ActorContext, input: EvaluationRunInput): Promise<EvaluationRunView> {
    assertCan(actor.principal!, Permission.EVALUATIONS_RUN);
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, input.agentId));
    if (!agent) throw notFound('agent', input.agentId);
    const candidate = await this.candidate(agent.id, agent.activePromptVersionId, input);
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(evaluationRuns).values({
        id,
        agentId: agent.id,
        baselineVersionId: agent.activePromptVersionId,
        candidateComponents: candidate,
        caseCount: input.caseCount,
        createdBy: actor.principal!.userId,
      });
      await recordAudit(tx, actor, {
        action: 'evaluation.create',
        targetType: 'evaluation_run',
        targetId: id,
        summary: `Replay evaluation of ${input.source === 'DRAFT' ? 'the prompt draft' : 'candidate components'} for ${agent.name} · ${input.caseCount} cases`,
      });
    });
    await this.queue.publish(EVALUATION_TOPIC, { evaluationRunId: id }, { dedupeKey: `evaluation:${id}` });
    return this.get(actor.principal!, id);
  }

  async list(principal: Principal, q: EvaluationRunQuery): Promise<EvaluationRunView[]> {
    assertCan(principal, Permission.EVALUATIONS_RUN);
    const rows = await this.db
      .select({ r: evaluationRuns, createdByName: users.name, baselineVersion: promptVersions.version })
      .from(evaluationRuns)
      .leftJoin(users, eq(users.id, evaluationRuns.createdBy))
      .leftJoin(promptVersions, eq(promptVersions.id, evaluationRuns.baselineVersionId))
      .where(q.agentId ? eq(evaluationRuns.agentId, q.agentId) : undefined)
      .orderBy(desc(evaluationRuns.createdAt))
      .limit(q.limit);
    return rows.map(({ r, createdByName, baselineVersion }) => view(r, createdByName, baselineVersion));
  }

  async get(principal: Principal, id: string): Promise<EvaluationRunView> {
    assertCan(principal, Permission.EVALUATIONS_RUN);
    const [row] = await this.db
      .select({ r: evaluationRuns, createdByName: users.name, baselineVersion: promptVersions.version })
      .from(evaluationRuns)
      .leftJoin(users, eq(users.id, evaluationRuns.createdBy))
      .leftJoin(promptVersions, eq(promptVersions.id, evaluationRuns.baselineVersionId))
      .where(eq(evaluationRuns.id, id));
    if (!row) throw notFound('evaluation_run', id);
    return view(row.r, row.createdByName, row.baselineVersion);
  }

  /** Per-case results. Contains customer text: evaluations.run (CS Lead) only. */
  async results(principal: Principal, id: string, q: EvaluationResultsQuery) {
    await this.get(principal, id);
    const rows = await this.db
      .select()
      .from(evaluationResults)
      .where(and(eq(evaluationResults.runId, id), q.changedOnly ? eq(evaluationResults.changed, true) : undefined, q.afterSeq !== undefined ? gt(evaluationResults.seq, q.afterSeq) : undefined))
      .orderBy(asc(evaluationResults.createdAt), asc(evaluationResults.id))
      .limit(q.limit);
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Full candidate component set: the draft, or explicit overrides on top of the active version. */
  private async candidate(agentId: string, activeVersionId: string | null, input: EvaluationRunInput): Promise<Record<BusinessComponentKey, string>> {
    let base: Partial<Record<BusinessComponentKey, string>> = {};
    if (input.source === 'DRAFT') {
      base = (await new PromptService(this.db).draft(agentId)).components;
    } else if (activeVersionId) {
      const [v] = await this.db.select({ components: promptVersions.components }).from(promptVersions).where(eq(promptVersions.id, activeVersionId));
      base = (v?.components ?? {}) as Partial<Record<BusinessComponentKey, string>>;
    }
    const merged = { ...base, ...(input.source === 'COMPONENTS' ? input.components : {}) };
    return Object.fromEntries(BUSINESS_COMPONENT_KEYS.map((k) => [k, merged[k] ?? ''])) as Record<BusinessComponentKey, string>;
  }
}

function view(r: EvaluationRunRow, createdByName: string | null, baselineVersion: number | null): EvaluationRunView {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    createdByName,
    baselineVersion,
    summaryDefinition: EVALUATION_SUMMARY_DEFINITION,
  };
}
