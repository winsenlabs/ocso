import { eq } from 'drizzle-orm';
import { SETTINGS_OBJECT_ID, recordAudit, seedDefaultAlertRules } from '@ocso/application';
import { auditEvents } from '@ocso/db';
import type { SeedContext } from './context.js';
import { USERS } from './data/organization.js';
import { approveAs, publishAgents, seedAgents } from './steps/agents.js';
import { seedWebChat } from './steps/channels.js';
import { seedMcp } from './steps/mcp.js';
import { seedModels } from './steps/models.js';
import { seedOrganization } from './steps/organization.js';
import { seedRouting } from './steps/routing.js';
import { approveRouting, seedRouters } from './steps/routers.js';

/** Audit action written once the demo is complete; its presence makes the seed a no-op. */
export const SEED_MARKER = 'demo.seed_completed';

export type SeedOutcome = { status: 'already_seeded' } | { status: 'seeded'; mcp: string; webchatPublicKey: string };

async function alreadySeeded(ctx: SeedContext): Promise<boolean> {
  const [row] = await ctx.db.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.action, SEED_MARKER)).limit(1);
  if (row) return true;
  // After the local window prune (ADR-032) the marker lives only in the audit store.
  const stored = await ctx.auditStore.query({ actionPrefix: SEED_MARKER, targetType: 'deployment', limit: 1 }, null).catch(() => []);
  return stored.some((r) => r.action === SEED_MARKER);
}

/**
 * Builds the Meridian Bank demo. Every step is idempotent (matched by natural
 * keys; an approval is skipped when its change is already in effect, and a
 * proposal left open by an earlier run is finished rather than resubmitted), so
 * a run interrupted half-way can simply be repeated; the marker is written last. A session-level advisory lock serializes concurrent runs.
 */
export async function runDemoSeed(ctx: SeedContext): Promise<SeedOutcome> {
  const client = await ctx.database.pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('ocso:demo-seed'))`);
    if (await alreadySeeded(ctx)) return { status: 'already_seeded' };

    const people = await seedOrganization(ctx);
    const queues = await seedRouting(ctx, people.lead, people.teamIds);
    const profiles = await seedModels(ctx, people.admin, people.lead);
    // Settings change only through an approval (PM/research/11 §4): the Tech admin proposes, a Head checks.
    // Skipped when already in effect (a re-run after an interruption): an unchanged UPDATE is refused as no_changes.
    if ((await ctx.services.settings.deployment()).internalAgentProfileId !== profiles.supportFast) {
      await approveAs(ctx, people.admin, people.lead, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', payload: { deployment: { internalAgentProfileId: profiles.supportFast } } }, 'Demo seed: the internal agent uses the fast profile');
    }
    const agents = await seedAgents(ctx, people.leads, { profiles, queues, teams: people.teamIds });
    const webchat = await seedWebChat(ctx, people.admin, people.lead);
    await seedRouters(ctx, people.leads, agents, queues, webchat.id);
    await publishAgents(ctx, people.leads, agents);
    await approveRouting(ctx, people.leads, queues);
    const mcp = await seedMcp(ctx, people.admin, people.lead, agents.maya, people.leads.lead2);
    const alerts = await seedDefaultAlertRules(ctx.db, ctx.correlationId);
    ctx.log(`default alert rules: ${alerts.created.length} created, ${alerts.existing} already present`);

    await ctx.db.transaction(async (tx) => {
      await recordAudit(tx, people.admin, {
        action: SEED_MARKER,
        targetType: 'deployment',
        summary: 'Meridian Bank demo data seeded',
        after: { users: USERS.map((u) => u.email), agents: Object.keys(agents), queues: Object.keys(queues), mcp },
      });
    });
    return { status: 'seeded', mcp, webchatPublicKey: webchat.publicKey };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('ocso:demo-seed'))`).catch(() => {});
    client.release();
  }
}

/** Human-readable summary: logins for all three roles. Never prints a non-default password. */
export function printLogins(ctx: SeedContext, outcome: SeedOutcome): void {
  const password = ctx.config.defaultPassword ? ctx.config.password : '(the value of OCSO_DEMO_PASSWORD)';
  const lines = [
    '',
    outcome.status === 'already_seeded' ? 'Meridian Bank demo is already seeded.' : 'Meridian Bank demo is ready.',
    `Sign in at ${ctx.config.api.OCSO_PUBLIC_URL}/login — password for every account: ${password}`,
    ...USERS.map((u) => `  ${u.role.padEnd(20)} ${u.name.padEnd(14)} ${u.email}`),
  ];
  if (outcome.status === 'seeded') {
    lines.push(`Web chat channel public key: ${outcome.webchatPublicKey}`, `Demo MCP connection: ${outcome.mcp}`);
  }
  console.log(lines.join('\n'));
}
