import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { at, num, observe, queryRows } from './support.js';

const Params = z
  .object({
    /** A worker counts as healthy only if its heartbeat is at most this old. */
    heartbeatSeconds: z.number().int().min(5).max(600).default(30),
    /** Overrides worker_settings.minWarmWorkers when set. */
    minimum: z.number().int().min(0).max(500).optional(),
  })
  .strict();

export const workersBelowMin = defineEvaluator({
  condition: 'workers_below_min',
  label: 'Healthy workers below minimum',
  kinds: ['TECHNICAL'],
  agentScoped: false,
  method:
    'Counts workers with status HEALTHY whose heartbeat is within `heartbeatSeconds` (default 30 s) of evaluation time and compares the count with worker_settings.minWarmWorkers (or `minimum`). Fires when healthy < minimum.',
  params: Params,
  async evaluate(ctx) {
    const fresh = new Date(ctx.now.getTime() - ctx.params.heartbeatSeconds * 1000);
    const [row] = await queryRows<{ healthy: number; total: number; min_warm: number | null }>(
      ctx.db,
      sql`SELECT
            count(*) FILTER (WHERE status = 'HEALTHY' AND heartbeat_at >= ${at(fresh)})::int AS healthy,
            count(*) FILTER (WHERE status IN ('STARTING', 'HEALTHY', 'DRAINING'))::int AS total,
            (SELECT min_warm_workers FROM worker_settings WHERE id = 1) AS min_warm
          FROM workers`,
    );
    const healthy = num(row?.healthy);
    const minimum = ctx.params.minimum ?? num(row?.min_warm);
    return [
      observe(ctx, {}, {
        firing: healthy < minimum,
        title: 'Healthy workers below minimum',
        value: `${formatCount(healthy)} of ${formatCount(minimum)}`,
        body: `${formatCount(healthy)} healthy worker(s) with a heartbeat in the last ${ctx.params.heartbeatSeconds}s against a minimum of ${formatCount(minimum)}. ${formatCount(num(row?.total))} worker(s) registered as running.`,
        source: 'Workers',
        context: { healthy, minimum, registered: num(row?.total), heartbeatSeconds: ctx.params.heartbeatSeconds },
      }),
    ];
  },
});
