import { sql } from 'drizzle-orm';
import { formatCount } from '@ocso/alerts';
import { z } from 'zod';
import { defineEvaluator } from './contract.js';
import { at, num, observe, queryRows, windowPhrase } from './support.js';

const Params = z
  .object({
    threshold: z.number().int().min(0).max(1_000_000).default(20),
  })
  .strict();

export const authFailuresAbove = defineEvaluator({
  condition: 'auth_failures_above',
  label: 'Sign-in failures above threshold',
  kinds: ['TECHNICAL'],
  agentScoped: false,
  method:
    'Count of login_attempts with success = false in the window (all accounts). Fires when the count exceeds `threshold`. Only counts of distinct accounts and IPs are recorded — never the addresses themselves.',
  params: Params,
  async evaluate(ctx) {
    const [row] = await queryRows<{ failures: number; accounts: number; ips: number }>(
      ctx.db,
      sql`SELECT count(*)::int AS failures,
                 count(DISTINCT lower(email))::int AS accounts,
                 count(DISTINCT ip)::int AS ips
            FROM login_attempts
           WHERE success = false AND occurred_at >= ${at(ctx.window.start)} AND occurred_at <= ${at(ctx.now)}`,
    );
    const failures = num(row?.failures);
    return [
      observe(ctx, {}, {
        firing: failures > ctx.params.threshold,
        title: `Sign-in failures above ${formatCount(ctx.params.threshold)}`,
        value: formatCount(failures),
        body: `${formatCount(failures)} failed sign-in attempt(s) ${windowPhrase(ctx)} across ${formatCount(num(row?.accounts))} account name(s) from ${formatCount(num(row?.ips))} IP address(es); threshold ${formatCount(ctx.params.threshold)}.`,
        source: 'Authentication',
        context: { failures, distinctAccounts: num(row?.accounts), distinctIps: num(row?.ips), threshold: ctx.params.threshold },
      }),
    ];
  },
});
