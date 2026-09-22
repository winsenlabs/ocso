import { Permission } from '@ocso/auth';
import { QueueService, SettingsService, WorkerSettingsInput, queryAudit } from '@ocso/application';
import { workers } from '@ocso/db';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { InternalTool } from '../contract.js';

export const workerCapacity: InternalTool<Record<string, never>> = {
  name: 'worker_capacity',
  description: 'Worker instances (status, active conversation slots, CPU/memory, heartbeat) and the worker scaling configuration.',
  input: z.object({}),
  permission: Permission.SYSTEM_READ,
  risk: 'READ',
  async run(ctx) {
    const [rows, config] = await Promise.all([ctx.db.select().from(workers).orderBy(desc(workers.heartbeatAt)).limit(50), new SettingsService(ctx.db).workers()]);
    const live = rows.filter((w) => w.status === 'HEALTHY' || w.status === 'DRAINING' || w.status === 'STARTING');
    const slots = live.reduce((n, w) => n + w.capacity, 0);
    const used = live.reduce((n, w) => n + w.activeLeases, 0);
    return {
      data: { workers: live.map((w) => ({ id: w.id, status: w.status, leases: w.activeLeases, capacity: w.capacity, cpu: w.cpuPercent, memoryMb: w.memoryMb, heartbeatAt: w.heartbeatAt })), slots, used, config },
      table: { columns: ['Worker', 'Status', 'Convs', 'Memory'], rows: live.map((w) => [w.id, w.status.toLowerCase(), `${w.activeLeases} / ${w.capacity}`, `${w.memoryMb ?? '—'} MB`]) },
      links: [{ label: `Worker pool · ${live.filter((w) => w.status === 'HEALTHY').length} of ${config.maxWorkers} healthy`, detail: `${used} of ${slots} slots used · min warm ${config.minWarmWorkers}`, href: '/system/workers' }],
    };
  },
};

export const updateWorkerSettings: InternalTool<z.infer<typeof WorkerSettingsInput>> = {
  name: 'update_worker_settings',
  description:
    'Change worker scaling configuration (minWarmWorkers, maxWorkers, conversationsPerWorker, targetUtilization, scaleOutQueueAgeSeconds, scaleInCooldownSeconds, turnTimeoutSeconds, leaseDurationSeconds, heartbeatIntervalSeconds). Sensitive: requires confirmation.',
  input: WorkerSettingsInput,
  permission: Permission.SYSTEM_CONFIGURE,
  risk: 'HIGH_WRITE',
  describe: (a) => `Worker configuration · ${Object.entries(a).map(([k, v]) => `${k} → ${String(v)}`).join(', ')}`,
  async run(ctx, args) {
    const after = await new SettingsService(ctx.db).updateWorkers(ctx.actor, args);
    return { data: after, links: [{ label: 'Worker configuration', detail: `min ${after.minWarmWorkers} · max ${after.maxWorkers} · ${after.conversationsPerWorker}/worker`, href: '/system/workers' }] };
  },
};

export const queueStatus: InternalTool<Record<string, never>> = {
  name: 'queue_status',
  description: 'Human queues: waiting conversations, oldest wait, SLA breaches, members on shift.',
  input: z.object({}),
  permission: Permission.QUEUES_READ,
  risk: 'READ',
  async run(ctx) {
    const queues = await new QueueService(ctx.db).list();
    return {
      data: queues.map((q) => ({ id: q.id, name: q.name, mode: q.mode, waiting: q.waiting, oldestWaitingSince: q.oldestWaitingSince, breaches: q.breaches, onShift: q.onShift, members: q.members })),
      table: { columns: ['Queue', 'Waiting', 'On shift', 'Breaches'], rows: queues.map((q) => [q.name, q.waiting, `${q.onShift} / ${q.members}`, q.breaches]) },
    };
  },
};

export const recentChanges: InternalTool<{ limit: number; targetType?: string | undefined }> = {
  name: 'recent_changes',
  description: 'Recent privileged changes from the immutable audit log (who changed what, when, via which surface).',
  input: z.object({ limit: z.number().int().min(1).max(50).default(15), targetType: z.string().max(60).optional() }),
  permission: Permission.AUDIT_READ,
  risk: 'READ',
  async run(ctx, args) {
    const rows = await queryAudit(ctx.db, { limit: args.limit, targetType: args.targetType });
    return { data: rows.map((r) => ({ at: r.occurredAt, actor: r.actorName, via: r.via, action: r.action, summary: r.summary, target: `${r.targetType}:${r.targetId ?? ''}` })) };
  },
};
