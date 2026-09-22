import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { notFound } from '@ocso/domain';
import { conversations, queueTeams, queues, slaPolicies, teamMembers, users, uuidv7, type Db } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

export const QueueInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).default('OPEN_PICKUP'),
  autoAssignAfterSeconds: z.number().int().min(10).max(86_400).nullable().default(null),
  acceptTimeoutSeconds: z.number().int().min(15).max(3_600).default(120),
  requiredSkills: z.array(z.string().max(60)).max(20).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  preferAccountOwner: z.boolean().default(true),
  slaPolicyId: z.uuid().nullable().default(null),
  teamIds: z.array(z.uuid()).default([]),
});
export type QueueInput = z.infer<typeof QueueInput>;
export const QueuePatch = QueueInput.partial();
export type QueuePatch = z.infer<typeof QueuePatch>;

export const SlaPolicyInput = z.object({
  name: z.string().trim().min(1).max(120),
  firstHumanResponseSeconds: z.number().int().min(30).max(604_800),
  pickupSecondsByPriority: z.partialRecord(z.enum(['P1', 'P2', 'P3', 'P4']), z.number().int().min(30).max(604_800)).default({}),
  resolutionSecondsByType: z.record(z.string(), z.number().int().min(60).max(2_592_000)).default({}),
  atRiskFraction: z.number().min(0.1).max(0.99).default(0.75),
});
export type SlaPolicyInput = z.infer<typeof SlaPolicyInput>;

export interface QueueView extends Omit<typeof queues.$inferSelect, 'createdAt' | 'updatedAt'> {
  teamIds: string[];
  waiting: number;
  oldestWaitingSince: string | null;
  onShift: number;
  members: number;
  breaches: number;
}

/** Queues, their teams and SLA policies (design/02 Routing tab, design/06 lead Queues table). */
export class QueueService {
  constructor(private readonly db: Db) {}

  async list(): Promise<QueueView[]> {
    const rows = await this.db.select().from(queues).orderBy(asc(queues.name));
    const links = await this.db.select().from(queueTeams);
    const stats = await this.db.execute<{ queue_id: string; waiting: number; oldest: Date | null; breaches: number }>(sql`
      SELECT queue_id, count(*) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN')::int AS waiting,
             min(waiting_since) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN') AS oldest,
             count(*) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN' AND sla_due_at < now())::int AS breaches
        FROM ${conversations} WHERE queue_id IS NOT NULL GROUP BY queue_id`);
    const staff = await this.db
      .select({ teamId: teamMembers.teamId, availability: users.availability })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId));
    return rows.map(({ createdAt: _c, updatedAt: _u, ...q }) => {
      const teamIds = links.filter((l) => l.queueId === q.id).map((l) => l.teamId);
      const people = staff.filter((s) => teamIds.includes(s.teamId));
      const s = stats.rows.find((r) => r.queue_id === q.id);
      return {
        ...q,
        teamIds,
        waiting: s?.waiting ?? 0,
        oldestWaitingSince: s?.oldest ? new Date(s.oldest).toISOString() : null,
        breaches: s?.breaches ?? 0,
        members: people.length,
        onShift: people.filter((p) => p.availability === 'AVAILABLE').length,
      };
    });
  }

  async create(actor: ActorContext, input: QueueInput): Promise<string> {
    assertCan(actor.principal!, Permission.QUEUES_MANAGE);
    const id = uuidv7();
    const { teamIds, ...fields } = input;
    await this.db.transaction(async (tx) => {
      await tx.insert(queues).values({ id, ...fields });
      if (teamIds.length) await tx.insert(queueTeams).values(teamIds.map((teamId) => ({ queueId: id, teamId })));
      await recordAudit(tx, actor, { action: 'queue.create', targetType: 'queue', targetId: id, summary: `Created queue ${input.name}`, after: input });
    });
    return id;
  }

  async update(actor: ActorContext, id: string, input: QueuePatch): Promise<void> {
    assertCan(actor.principal!, Permission.QUEUES_MANAGE);
    const { teamIds, ...fields } = input;
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(queues).where(eq(queues.id, id));
      if (!before) throw notFound('queue', id);
      await tx.update(queues).set({ ...fields, updatedAt: new Date() }).where(eq(queues.id, id));
      if (teamIds) {
        await tx.delete(queueTeams).where(eq(queueTeams.queueId, id));
        if (teamIds.length) await tx.insert(queueTeams).values(teamIds.map((teamId) => ({ queueId: id, teamId })));
      }
      await recordAudit(tx, actor, { action: 'queue.update', targetType: 'queue', targetId: id, summary: `Updated queue ${before.name}`, before, after: input });
    });
  }

  listSlaPolicies() {
    return this.db.select().from(slaPolicies).orderBy(asc(slaPolicies.name));
  }

  async saveSlaPolicy(actor: ActorContext, id: string | null, input: SlaPolicyInput): Promise<string> {
    assertCan(actor.principal!, Permission.SLA_MANAGE);
    const policyId = id ?? uuidv7();
    await this.db.transaction(async (tx) => {
      if (id) {
        const updated = await tx.update(slaPolicies).set({ ...input, updatedAt: new Date() }).where(eq(slaPolicies.id, id)).returning({ id: slaPolicies.id });
        if (!updated.length) throw notFound('sla_policy', id);
      } else {
        await tx.insert(slaPolicies).values({ id: policyId, ...input });
      }
      await recordAudit(tx, actor, { action: id ? 'sla_policy.update' : 'sla_policy.create', targetType: 'sla_policy', targetId: policyId, summary: `SLA policy ${input.name}`, after: input });
    });
    return policyId;
  }

  async queuesForTeams(teamIds: readonly string[]): Promise<string[]> {
    if (!teamIds.length) return [];
    const rows = await this.db.select({ queueId: queueTeams.queueId }).from(queueTeams).where(inArray(queueTeams.teamId, [...teamIds]));
    return [...new Set(rows.map((r) => r.queueId))];
  }
}
