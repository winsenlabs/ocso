import { eq, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { isDomainError } from '@ocso/domain';
import { modelProfiles, modelProviders, type DbOrTx } from '@ocso/db';
import type { ProviderRegistry } from '@ocso/model-providers';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { isApproved } from '../approvals/guard.js';
import { definedOnly, platformTitle, platformVisible } from '../settings/platform-approvals.js';
import { ProfilePatch } from './inputs.js';
import { checkProfileTargets } from './model-policy.js';
import { agentsByProfile } from './references.js';
import type { ProfileRow } from './views.js';

/**
 * Model profiles under maker–checker (PM/research/11 §4, approvals.check.platform). A profile has no status
 * of its own, so "live" is derived from use: a profile is live while a live or paused agent, an active router
 * (a CLASSIFY step of its active version) or the internal OCSO agent uses it. A profile nothing live uses is
 * a draft — inert, freely editable. A live or approved profile changes only through an UPDATE proposal, so a
 * draft a live agent picked up cannot be edited around the checker. ACTIVATE ("approve for use") records the
 * platform approval of a profile before anything uses it; DELETE is always a proposal.
 */

/** Profiles a live thing uses right now (see the file comment). */
export async function profilesInUse(tx: DbOrTx, ids?: readonly string[]): Promise<Set<string>> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM (
      SELECT unnest(ARRAY[model_profile_id, summarizer_profile_id, copilot_profile_id]) AS id
        FROM virtual_agents WHERE status IN ('LIVE', 'PAUSED')
      UNION SELECT internal_agent_profile_id FROM deployment_settings
      UNION SELECT (step->>'modelProfileId')::uuid
        FROM routers r JOIN router_versions v ON v.id = r.active_version_id,
             jsonb_array_elements(COALESCE(v.definition->'steps', '[]'::jsonb)) step
       WHERE r.status = 'ACTIVE' AND step->>'kind' = 'CLASSIFY' AND step->>'modelProfileId' ~ '^[0-9a-f-]{36}$'
    ) used WHERE id IS NOT NULL AND id IN (SELECT id FROM model_profiles)`);
  const inUse = new Set(rows.rows.map((r) => r.id));
  return ids ? new Set(ids.filter((id) => inUse.has(id))) : inUse;
}

async function load(tx: DbOrTx, id: string): Promise<ProfileRow | null> {
  const [row] = await tx.select().from(modelProfiles).where(eq(modelProfiles.id, id));
  return row ?? null;
}

async function projectRow(tx: DbOrTx, row: ProfileRow): Promise<Record<string, unknown>> {
  const providerIds = [row.providerId, ...row.fallbacks.map((f) => f.providerId)];
  const providers = new Map((await tx.select({ id: modelProviders.id, name: modelProviders.name }).from(modelProviders)).filter((p) => providerIds.includes(p.id)).map((p) => [p.id, p.name]));
  const name = (id: string) => providers.get(id) ?? `missing (${id.slice(0, 8)})`;
  return {
    name: row.name,
    description: row.description,
    provider: name(row.providerId),
    model: row.model,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    timeoutMs: row.timeoutMs,
    retries: row.retries,
    retryBackoffMs: row.retryBackoffMs,
    cachePolicy: row.cachePolicy,
    cacheTtl: row.cacheTtl,
    fallbacks: row.fallbacks.map((f) => `${name(f.providerId)} · ${f.model}`),
    requiredCapabilities: row.requiredCapabilities,
    usedBy: ((await agentsByProfile(tx, [row.id])).get(row.id) ?? []).map((a) => `${a.name} (${a.usage.toLowerCase()})`).sort(),
  };
}

function applied(row: ProfileRow, patch: ProfilePatch): ProfileRow {
  const defined = definedOnly(patch) as Partial<ProfileRow>;
  if (patch.requiredCapabilities) defined.requiredCapabilities = Object.fromEntries(Object.entries(patch.requiredCapabilities).filter((e): e is [string, boolean] => e[1] !== undefined));
  return { ...row, ...defined };
}

export function profileApproval(deps: { providers?: ProviderRegistry | undefined } = {}): ApprovalDescriptor {
  return {
    kind: 'model_profile',
    label: 'Model profile',
    actions: ['ACTIVATE', 'UPDATE', 'DELETE'],
    makePermission: () => Permission.MODEL_PROFILES_MANAGE,
    checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
    payload: ProfilePatch,
    // Which agents use it is context for the checker; an agent picking it up must not void an open proposal.
    hashExclude: ['usedBy'],

    async project(tx, id) {
      const row = await load(tx, id);
      return row ? projectRow(tx, row) : null;
    },
    async projectAfter(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row || p.action === 'DELETE') return null;
      if (p.action === 'ACTIVATE') return projectRow(tx, row);
      return projectRow(tx, applied(row, p.payload as ProfilePatch));
    },
    teamIds: async () => [],
    async dependencies(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [];
      const target = p.action === 'UPDATE' ? applied(row, p.payload as ProfilePatch) : row;
      const ids = [...new Set([target.providerId, ...target.fallbacks.map((f) => f.providerId)])];
      const providers = await tx.select({ id: modelProviders.id, updatedAt: modelProviders.updatedAt }).from(modelProviders);
      return ids.map((id) => `model_provider:${id}@${providers.find((x) => x.id === id)?.updatedAt.toISOString() ?? 'missing'}`);
    },
    assertVisible: platformVisible([Permission.PROVIDERS_READ, Permission.AGENTS_READ]),
    assertMakeable: platformVisible(Permission.MODEL_PROFILES_MANAGE),
    async requiresApproval(tx, id, action) {
      if (action === 'ACTIVATE' || action === 'DELETE') return true;
      return (await isApproved(tx, 'model_profile', id)) || (await profilesInUse(tx, [id])).size > 0;
    },
    async validate(tx, p) {
      const row = await load(tx, p.objectId);
      if (!row) return [{ code: 'object_missing', message: 'The model profile no longer exists.' }];
      if (p.action === 'DELETE') {
        const agents = (await agentsByProfile(tx, [row.id])).get(row.id) ?? [];
        const problems: ApprovalProblem[] = [];
        if (agents.length) problems.push({ code: 'model_profile_in_use', message: `${row.name} is used by virtual agents (${[...new Set(agents.map((a) => a.name))].join(', ')}); reassign them first.` });
        else if ((await profilesInUse(tx, [row.id])).size) problems.push({ code: 'model_profile_in_use', message: `${row.name} is used by a router or the internal agent; reassign it first.` });
        return problems;
      }
      if (p.action === 'ACTIVATE' && (await isApproved(tx, 'model_profile', row.id))) return [{ code: 'already_approved', message: 'The profile is already approved for use.' }];
      const target = p.action === 'UPDATE' ? applied(row, p.payload as ProfilePatch) : row;
      const problems: ApprovalProblem[] = [];
      if (target.name !== row.name) {
        const [clash] = await tx.select({ id: modelProfiles.id }).from(modelProfiles).where(eq(modelProfiles.name, target.name));
        if (clash && clash.id !== row.id) problems.push({ code: 'model_profile_name_taken', message: `A model profile named ${target.name} already exists.` });
      }
      if (!deps.providers) return [...problems, { code: 'profile_validation_unavailable', message: 'The model policy cannot be checked in this process.' }];
      try {
        const policy = await checkProfileTargets(tx, deps.providers, target, new Date());
        if (!policy.ok) problems.push({ code: 'model_target_not_permitted', message: policy.message });
      } catch (err) {
        problems.push(isDomainError(err) ? { code: err.code, message: err.message } : { code: 'model_policy_failed', message: 'The model policy check failed.' });
      }
      return problems;
    },
    async activate(tx, actor, p) {
      const row = (await load(tx, p.objectId))!;
      if (p.action === 'DELETE') {
        await tx.delete(modelProfiles).where(eq(modelProfiles.id, row.id));
        await recordAudit(tx, actor, { action: 'model_profile.delete', targetType: 'model_profile', targetId: row.id, summary: `Deleted model profile ${row.name}`, before: { name: row.name, providerId: row.providerId, model: row.model } });
      } else if (p.action === 'ACTIVATE') {
        await recordAudit(tx, actor, { action: 'model_profile.approve', targetType: 'model_profile', targetId: row.id, summary: `Approved model profile ${row.name} for use` });
      } else {
        const next = applied(row, p.payload as ProfilePatch);
        const { id: _id, createdAt: _c, updatedAt: _u, configVersion: _v, ...fields } = next;
        await tx
          .update(modelProfiles)
          .set({ ...fields, configVersion: sql`${modelProfiles.configVersion} + 1`, updatedAt: new Date() })
          .where(eq(modelProfiles.id, row.id));
        await recordAudit(tx, actor, { action: 'model_profile.update', targetType: 'model_profile', targetId: row.id, summary: `Updated model profile ${row.name}`, before: { name: row.name, providerId: row.providerId, model: row.model }, after: p.payload });
        await bumpGeneration(tx, actor.correlationId, `profile:${row.id}`, 'model_config_changed');
      }
      await emitEvent(tx, actor, 'config.changed', { area: 'model_profile', entityId: row.id });
      return { kind: 'DONE' };
    },
    async liveObjects(tx) {
      return [...(await profilesInUse(tx))];
    },
    title: (p: ProposalRow, before) => platformTitle(p, before, { noun: 'model profile', activateVerb: 'Approve' }),
  };
}
