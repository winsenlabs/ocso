import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { DomainError, partToPlainText } from '@ocso/domain';
import { conversationInsights, conversations, handoffs, virtualAgents, type Db } from '@ocso/db';
import { z } from 'zod';
import type { ModelGateway } from '../model/gateway.js';
import { loadHistory } from '../context/history.js';

export const INSIGHT_OUTCOMES = ['RESOLVED_BY_AI', 'RESOLVED_BY_HUMAN', 'ESCALATED', 'ABANDONED', 'UNRESOLVED'] as const;
export const INSIGHT_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;
export const INSIGHTS_TOPIC = 'conversation.insights' as const;

const INSIGHTS_SYSTEM = `You label one finished customer-service conversation for business analytics. Output JSON only, matching the schema.
- topic: what the customer needed, a short noun phrase of 2-6 words (e.g. "duplicate EMI debit"). Use generic wording, never names, numbers or identifiers.
- outcome: RESOLVED_BY_AI (the AI agent resolved it with no human), RESOLVED_BY_HUMAN (a human colleague resolved it), ESCALATED (handed to a human and not yet resolved), ABANDONED (the customer stopped responding before resolution), UNRESOLVED (ended without resolving the need).
- escalationReason: when a handoff happened, the underlying reason in 2-6 words; otherwise null.
- knowledgeGap: a fact, policy or product detail the agent did not know or could not find (2-8 words); otherwise null.
- failureTopic: when the agent failed to help (wrong answer, repeated questions, could not act), the topic it failed on (2-6 words); otherwise null.
- sentiment: the customer's sentiment at the end.
- salesOutcome: only for SALES conversations: CONVERTED, INTERESTED, FOLLOW_UP, NOT_INTERESTED or NO_OPPORTUNITY; otherwise null.
- turnsBeforeEscalation: agent replies before the first escalation, or null.
Base every field only on the transcript and facts given. Never include personal data.`;

const nullableText = (description: string) => ({ type: ['string', 'null'], description });

export const INSIGHTS_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'outcome', 'escalationReason', 'knowledgeGap', 'failureTopic', 'sentiment', 'salesOutcome', 'turnsBeforeEscalation'],
  properties: {
    topic: { type: 'string', description: 'What the customer needed (2-6 words).' },
    outcome: { type: 'string', enum: [...INSIGHT_OUTCOMES] },
    escalationReason: nullableText('Underlying reason for the handoff, or null.'),
    knowledgeGap: nullableText('Missing fact/policy, or null.'),
    failureTopic: nullableText('Topic the agent failed on, or null.'),
    sentiment: { type: 'string', enum: [...INSIGHT_SENTIMENTS] },
    salesOutcome: nullableText('SALES conversations only, else null.'),
    turnsBeforeEscalation: { type: ['integer', 'null'] },
  },
};

/** Method identity recorded on every row: prompt + schema hash (a change in either yields a new version). */
export const INSIGHTS_METHOD_VERSION = `insights.v1+${createHash('sha256').update(INSIGHTS_SYSTEM).update(JSON.stringify(INSIGHTS_RESPONSE_SCHEMA)).digest('hex').slice(0, 10)}`;

const label = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => (v === null ? null : v.replace(/\s+/g, ' ').trim().slice(0, max) || null));

const InsightOutput = z.object({
  topic: label(120),
  outcome: z.enum(INSIGHT_OUTCOMES),
  escalationReason: label(160),
  knowledgeGap: label(200),
  failureTopic: label(120),
  sentiment: z.enum(INSIGHT_SENTIMENTS),
  salesOutcome: label(60).transform((v) => (v ? v.toUpperCase().replace(/\s+/g, '_') : null)),
  turnsBeforeEscalation: z.number().int().min(0).max(10_000).nullable(),
});
export type InsightOutput = z.infer<typeof InsightOutput>;

export type InsightRow = typeof conversationInsights.$inferSelect;
export type InsightResult = { status: 'stored'; insight: InsightRow } | { status: 'skipped'; reason: 'not_found' | 'no_profile' | 'no_messages' };

const MAX_TRANSCRIPT_CHARS = 30_000;

/** Parse structured output, or JSON in text when the provider returned it as text. */
export function parseInsightOutput(structured: unknown, text: string): InsightOutput {
  let raw = structured;
  if (raw === undefined || raw === null) {
    const match = /\{[\s\S]*\}/.exec(text);
    try {
      raw = match ? JSON.parse(match[0]) : undefined;
    } catch {
      raw = undefined;
    }
  }
  const parsed = InsightOutput.safeParse(raw);
  if (!parsed.success) throw new DomainError('internal', 'insights_output_invalid', 'Classifier output did not match the insights schema');
  return parsed.data;
}

/**
 * Conversation insights on resolution (queue topic `conversation.insights`,
 * docs/archive/specs/11 §3). Explicit classifier output over the customer-visible transcript
 * plus handoff reasons, stored with its method version so every analytics
 * number can be traced to a method. turnsBeforeEscalation is recomputed from
 * the data (agent replies before the first non-HUMAN_REQUEST handoff) rather
 * than trusted from the model.
 */
export class ConversationInsightsService {
  constructor(
    private readonly db: Db,
    private readonly gateway: ModelGateway,
  ) {}

  async analyze(conversationId: string, correlationId = `insights:${conversationId}`): Promise<InsightResult> {
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, conversationId));
    if (!conv) return { status: 'skipped', reason: 'not_found' };
    // Resolved while a router was still deciding: no agent to attribute insights to.
    if (!conv.agentId) return { status: 'skipped', reason: 'no_profile' };
    const [agent] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, conv.agentId));
    const profileId = agent?.summarizerProfileId ?? agent?.modelProfileId;
    if (!agent || !profileId) return { status: 'skipped', reason: 'no_profile' };
    const history = await loadHistory(this.db, conversationId, 0, conv.lastSeq, 400);
    if (!history.length) return { status: 'skipped', reason: 'no_messages' };

    const handoffRows = await this.db
      .select({
        trigger: handoffs.trigger,
        reasonCode: handoffs.reasonCode,
        reasonText: handoffs.reasonText,
        afterSeq: sql<number | null>`(SELECT max(i.seq) FROM interactions i WHERE i.conversation_id = ${handoffs.conversationId} AND i.created_at <= ${handoffs.requestedAt})`,
      })
      .from(handoffs)
      .where(eq(handoffs.conversationId, conversationId))
      .orderBy(asc(handoffs.requestedAt));
    const firstEscalation = handoffRows.find((h) => h.trigger !== 'HUMAN_REQUEST');
    const turnsBeforeEscalation = firstEscalation
      ? history.filter((h) => h.actorType === 'AGENT' && h.seq <= Number(firstEscalation.afterSeq ?? 0)).length
      : null;

    const lines = history.map((h) => `[${h.seq}] ${h.actorType === 'CUSTOMER' ? 'Customer' : h.actorType === 'HUMAN' ? 'Human colleague' : 'AI agent'}: ${h.parts.map(partToPlainText).join(' ')}`);
    let transcript = lines.join('\n');
    while (transcript.length > MAX_TRANSCRIPT_CHARS && lines.length > 1) {
      lines.shift();
      transcript = `(earlier messages omitted)\n${lines.join('\n')}`;
    }
    const facts = [
      `Conversation type: ${conv.type}`,
      `Final control state: ${conv.controlState}`,
      `A human colleague replied: ${history.some((h) => h.actorType === 'HUMAN') ? 'yes' : 'no'}`,
      ...handoffRows.map((h) => `Handoff after message ${h.afterSeq ?? 0}: trigger ${h.trigger}, reason "${h.reasonText}" (${h.reasonCode})`),
    ].join('\n');

    const result = await this.gateway.run({
      profileId,
      purpose: 'CLASSIFIER',
      system: [{ key: 'insights_instructions', text: INSIGHTS_SYSTEM, stable: true, breakpointAfter: 'AGENT_PREFIX' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: `Facts:\n${facts}\n\nTranscript (customer-visible messages only):\n${transcript}` }] }],
      tools: [],
      responseSchema: INSIGHTS_RESPONSE_SCHEMA,
      required: { structuredOutput: true },
      context: { correlationId, conversationId, agentId: conv.agentId, purpose: 'CLASSIFIER' },
    });
    const out = parseInsightOutput(result.structured, result.text);
    const values = {
      agentId: agent.id,
      topic: out.topic,
      outcome: out.outcome,
      escalationReason: out.escalationReason,
      knowledgeGap: out.knowledgeGap,
      failureTopic: out.failureTopic,
      sentiment: out.sentiment,
      salesOutcome: agent.conversationType === 'SALES' ? out.salesOutcome : null,
      turnsBeforeEscalation,
      methodVersion: INSIGHTS_METHOD_VERSION,
      usageEventId: result.usageEventId,
      generatedAt: new Date(),
    };
    const [insight] = await this.db
      .insert(conversationInsights)
      .values({ conversationId, ...values })
      .onConflictDoUpdate({ target: conversationInsights.conversationId, set: values })
      .returning();
    return { status: 'stored', insight: insight! };
  }
}
