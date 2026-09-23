import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { displayId, notFound } from '@ocso/domain';
import { conversationReviews, conversations, customers, users, uuidv7, virtualAgents, type Db } from '@ocso/db';
import { z } from 'zod';
import { assertAgentReadable, manageableAgentsSql, readableAgentFilter } from '../agents/access.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

/** Explicit review rubric (docs/11 §3: no opaque quality score). Each criterion is scored 1–5. */
export const REVIEW_RUBRIC = {
  accuracy: 'Facts, amounts and references the agent stated were correct.',
  policy: 'Policies and compliance rules were followed; escalation happened when the policy required it.',
  tone: "Clear, respectful and in the customer's language; no over-promising.",
  resolution: 'The conversation reached a resolution, or a timely and well-summarized handoff.',
} as const;
export type RubricCriterion = keyof typeof REVIEW_RUBRIC;

/** Suggested outcome tags; the tag itself is free text. */
export const REVIEW_OUTCOME_TAGS = [
  'contained',
  'good handoff',
  'late escalation',
  'missed escalation',
  'unnecessary handoff',
  'wrong policy quoted',
  'policy limit',
  'knowledge gap',
  'tool misuse',
  'tone issue',
] as const;

export const REVIEW_SCORE_DEFINITION = 'score = arithmetic mean of the four rubric criteria (accuracy, policy, tone, resolution), each 1–5, rounded to 2 decimals.';

const Criterion = z.number().int().min(1).max(5);
export const ReviewInput = z.object({
  conversationId: z.uuid(),
  rubric: z.object({ accuracy: Criterion, policy: Criterion, tone: Criterion, resolution: Criterion }).strict(),
  outcomeTag: z.string().trim().min(1).max(60),
  notes: z.string().trim().max(4_000).optional(),
});
export type ReviewInput = z.infer<typeof ReviewInput>;

export const ReviewQuery = z.object({
  agentId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ReviewQuery = z.infer<typeof ReviewQuery>;

export interface ReviewView {
  id: string;
  conversationId: string;
  displayId: string;
  agent: { id: string; name: string };
  reviewer: { id: string; name: string };
  customerName: string | null;
  controlState: string;
  rubric: Record<string, number>;
  score: number;
  outcomeTag: string;
  notes: string | null;
  createdAt: string;
}

export function rubricScore(rubric: Record<RubricCriterion, number>): number {
  const values = Object.keys(REVIEW_RUBRIC).map((k) => rubric[k as RubricCriterion]);
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/**
 * Conversation reviews by Leads (design/02 "Latest reviewed conversations").
 * A lead reviews and reads reviews of the agents their teams own (ADR-026);
 * other conversations and agents are not found.
 */
export class ReviewService {
  constructor(private readonly db: Db) {}

  rubric() {
    return { criteria: REVIEW_RUBRIC, scale: { min: 1, max: 5 }, outcomeTags: REVIEW_OUTCOME_TAGS, scoreDefinition: REVIEW_SCORE_DEFINITION };
  }

  async create(actor: ActorContext, input: ReviewInput): Promise<ReviewView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.REVIEWS_MANAGE);
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      const [conv] = await tx
        .select({ agentId: conversations.agentId })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), sql`${conversations.agentId} IN (${manageableAgentsSql(principal)})`));
      if (!conv) throw notFound('conversation', input.conversationId);
      const score = rubricScore(input.rubric);
      await tx.insert(conversationReviews).values({
        id,
        conversationId: input.conversationId,
        agentId: conv.agentId,
        reviewerId: principal.userId,
        outcomeTag: input.outcomeTag,
        score,
        rubric: input.rubric,
        notes: input.notes ?? null,
      });
      await recordAudit(tx, actor, {
        action: 'review.create',
        targetType: 'conversation',
        targetId: input.conversationId,
        summary: `Reviewed ${displayId('conv', input.conversationId)}: ${input.outcomeTag} · score ${score}`,
        after: { rubric: input.rubric, score, outcomeTag: input.outcomeTag },
      });
    });
    const [view] = await this.query(eq(conversationReviews.id, id), 1);
    return view!;
  }

  async list(principal: Principal, q: ReviewQuery): Promise<ReviewView[]> {
    assertCan(principal, Permission.REVIEWS_MANAGE);
    if (q.agentId) await assertAgentReadable(this.db, principal, q.agentId);
    const where = and(
      readableAgentFilter(principal, conversationReviews.agentId),
      q.agentId ? eq(conversationReviews.agentId, q.agentId) : undefined,
      q.conversationId ? eq(conversationReviews.conversationId, q.conversationId) : undefined,
      q.before ? lt(conversationReviews.createdAt, new Date(q.before)) : undefined,
    );
    return this.query(where, q.limit);
  }

  private async query(where: SQL | undefined, limit: number): Promise<ReviewView[]> {
    const rows = await this.db
      .select({ r: conversationReviews, agentName: virtualAgents.name, reviewerName: users.name, customerName: customers.displayName, controlState: conversations.controlState })
      .from(conversationReviews)
      .innerJoin(conversations, eq(conversations.id, conversationReviews.conversationId))
      .innerJoin(customers, eq(customers.id, conversations.customerId))
      .innerJoin(virtualAgents, eq(virtualAgents.id, conversationReviews.agentId))
      .innerJoin(users, eq(users.id, conversationReviews.reviewerId))
      .where(where)
      .orderBy(desc(conversationReviews.createdAt))
      .limit(limit);
    return rows.map(({ r, agentName, reviewerName, customerName, controlState }) => ({
      id: r.id,
      conversationId: r.conversationId,
      displayId: displayId('conv', r.conversationId),
      agent: { id: r.agentId, name: agentName },
      reviewer: { id: r.reviewerId, name: reviewerName },
      customerName,
      controlState,
      rubric: r.rubric,
      score: r.score,
      outcomeTag: r.outcomeTag,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
