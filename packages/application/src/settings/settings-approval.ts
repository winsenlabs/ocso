import { eq } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { authPolicy, deploymentSettings, modelProfiles, workerSettings, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { AuthPolicyInput, applyAuthPolicy } from '../identity/auth-policy.js';
import { loadPrincipal } from '../identity/sessions.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { RetentionInput, effectiveRetention } from '../retention/policy.js';
import { modelProfileProblems } from '../routing/approval-checks.js';
import { describeDiff, diffFields } from '@ocso/domain';
import { platformVisible } from './platform-approvals.js';
import { DeploymentSettingsInput, SETTINGS_OBJECT_ID, WorkerSettingsInput, applyDeploymentSettings, applyWorkerSettings, mergedWorkerSettings } from './settings.js';

/**
 * The deployment settings under maker–checker (PM/research/11 §4, approvals.check.platform): one descriptor
 * on the singleton (object id SETTINGS_OBJECT_ID) whose payload carries one or more sections — deployment
 * (identity, residency, model policy, egress, the internal agent), visibility policy, retention, worker
 * settings, sign-in security (MFA), the approval age threshold and the audit local window. Settings are
 * always live, so every change is a proposal; one settings proposal is open at a time (edit it to add a
 * section). Worker settings also need system.configure, checked against the maker at every validation.
 */

const DeploymentSection = DeploymentSettingsInput.omit({ execsCanViewAiActive: true, retention: true, auditLocalWindowDays: true, approvalAgeWarningHours: true }).strict();

export const SettingsChange = z
  .object({
    deployment: DeploymentSection.optional(),
    visibility: z.object({ execsCanViewAiActive: z.boolean() }).strict().optional(),
    retention: RetentionInput.optional(),
    workers: WorkerSettingsInput.optional(),
    mfa: AuthPolicyInput.optional(),
    approvals: z.object({ approvalAgeWarningHours: z.number().int().min(1).max(24 * 90) }).strict().optional(),
    audit: z.object({ auditLocalWindowDays: z.number().int().min(90).max(3650) }).strict().optional(),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), 'Change at least one setting');
export type SettingsChange = z.output<typeof SettingsChange>;
export const SETTINGS_SECTIONS = ['deployment', 'visibility', 'retention', 'workers', 'mfa', 'approvals', 'audit'] as const;

/** Split the flat PATCH /v1/settings/deployment body into its sections. */
export function sectionsOfDeploymentInput(input: DeploymentSettingsInput): SettingsChange {
  const { execsCanViewAiActive, retention, auditLocalWindowDays, approvalAgeWarningHours, ...deployment } = input;
  const defined = Object.fromEntries(Object.entries(deployment).filter(([, v]) => v !== undefined));
  return {
    ...(Object.keys(defined).length ? { deployment: defined as z.output<typeof DeploymentSection> } : {}),
    ...(execsCanViewAiActive !== undefined ? { visibility: { execsCanViewAiActive } } : {}),
    ...(retention !== undefined ? { retention } : {}),
    ...(approvalAgeWarningHours !== undefined ? { approvals: { approvalAgeWarningHours } } : {}),
    ...(auditLocalWindowDays !== undefined ? { audit: { auditLocalWindowDays } } : {}),
  };
}

const DEPLOYMENT_KEYS = Object.keys(DeploymentSection.shape) as Array<keyof z.output<typeof DeploymentSection>>;
const WORKER_KEYS = ['minWarmWorkers', 'maxWorkers', 'conversationsPerWorker', 'targetUtilization', 'scaleOutQueueAgeSeconds', 'scaleOutQueueDepth', 'scaleInCooldownSeconds', 'turnTimeoutSeconds', 'leaseDurationSeconds', 'heartbeatIntervalSeconds', 'idleLeaseSeconds', 'autoscalingEnabled'] as const;

async function current(tx: DbOrTx) {
  const [[d], [w], [a]] = await Promise.all([
    tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1)),
    tx.select().from(workerSettings).where(eq(workerSettings.id, 1)),
    tx.select().from(authPolicy).where(eq(authPolicy.id, 1)),
  ]);
  return { d: d!, w: w!, mfa: [...(a?.requireMfaRoles ?? [])].sort() };
}

const pick = <T extends object>(o: T, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k] ?? null]));

async function project(tx: DbOrTx, change?: SettingsChange): Promise<Record<string, unknown>> {
  const { d, w, mfa } = await current(tx);
  return {
    name: 'deployment settings',
    deployment: { ...pick(d, DEPLOYMENT_KEYS), ...(change?.deployment ?? {}) },
    visibility: { execsCanViewAiActive: change?.visibility?.execsCanViewAiActive ?? d.execsCanViewAiActive },
    retention: effectiveRetention({ ...d.retention, ...(change?.retention ?? {}) }),
    workers: { ...pick(w, WORKER_KEYS), ...(change?.workers ?? {}) },
    mfa: { requireMfaRoles: change?.mfa ? [...new Set(change.mfa.requireMfaRoles)].sort() : mfa },
    approvals: { approvalAgeWarningHours: change?.approvals?.approvalAgeWarningHours ?? d.approvalAgeWarningHours },
    audit: { auditLocalWindowDays: change?.audit?.auditLocalWindowDays ?? d.auditLocalWindowDays },
  };
}

export const settingsApproval: ApprovalDescriptor = {
  kind: 'deployment_settings',
  label: 'Deployment settings',
  actions: ['UPDATE'],
  makePermission: () => Permission.DEPLOYMENT_SETTINGS_MANAGE,
  // Worker settings are system.configure's (PATCH /v1/settings/workers); validate() checks each section's right.
  mayMake: (principal) => can(principal, Permission.DEPLOYMENT_SETTINGS_MANAGE) || can(principal, Permission.SYSTEM_CONFIGURE),
  checkPermission: Permission.APPROVALS_CHECK_PLATFORM,
  payload: SettingsChange,

  async project(tx, id) {
    return id === SETTINGS_OBJECT_ID ? project(tx) : null;
  },
  async projectAfter(tx, p) {
    return p.objectId === SETTINGS_OBJECT_ID ? project(tx, p.payload as SettingsChange) : null;
  },
  teamIds: async () => [],
  async dependencies(tx, p) {
    const profileId = (p.payload as SettingsChange).deployment?.internalAgentProfileId;
    if (!profileId) return [];
    const [row] = await tx.select({ updatedAt: modelProfiles.updatedAt }).from(modelProfiles).where(eq(modelProfiles.id, profileId));
    return [`model_profile:${profileId}@${row?.updatedAt.toISOString() ?? 'missing'}`];
  },
  assertVisible: platformVisible([Permission.DEPLOYMENT_SETTINGS_MANAGE, Permission.SYSTEM_CONFIGURE]),
  // Settings are always live: every change is a proposal.
  requiresApproval: async () => true,
  async validate(tx, p) {
    const change = p.payload as SettingsChange;
    const problems: ApprovalProblem[] = [];
    if (change.workers) {
      const maker = p.makerId ? await loadPrincipal(tx, p.makerId, 'SYSTEM') : null;
      if (!maker || !can(maker, Permission.SYSTEM_CONFIGURE)) problems.push({ code: 'workers_not_permitted', message: 'Worker settings need system.configure; the maker does not hold it.' });
      const [w] = await tx.select().from(workerSettings).where(eq(workerSettings.id, 1));
      const merged = mergedWorkerSettings(w!, change.workers);
      if (!merged.ok) problems.push({ code: 'invalid_worker_settings', message: merged.message });
    }
    // A retention below the audit floor never parses (RetentionInput): refused at submit as invalid_payload.
    const others = SETTINGS_SECTIONS.filter((s) => s !== 'workers' && change[s] !== undefined);
    if (others.length) {
      const maker = p.makerId ? await loadPrincipal(tx, p.makerId, 'SYSTEM') : null;
      if (!maker || !can(maker, Permission.DEPLOYMENT_SETTINGS_MANAGE)) problems.push({ code: 'settings_not_permitted', message: `Changing ${others.join(', ')} settings needs deployment_settings.manage; the maker does not hold it.` });
    }
    // The internal agent calls only a model profile a platform checker approved.
    const profileId = change.deployment?.internalAgentProfileId;
    if (profileId) problems.push(...(await modelProfileProblems(tx, [profileId])));
    return problems;
  },
  async activate(tx, actor, p) {
    const change = p.payload as SettingsChange;
    const [d] = await tx.select().from(deploymentSettings).where(eq(deploymentSettings.id, 1));
    const patch: DeploymentSettingsInput = {
      ...(change.deployment ?? {}),
      ...(change.visibility ?? {}),
      ...(change.retention ? { retention: { ...(d!.retention as Record<string, number>), ...change.retention } } : {}),
      ...(change.approvals ?? {}),
      ...(change.audit ?? {}),
    };
    if (Object.keys(patch).length) await applyDeploymentSettings(tx, actor, patch);
    if (change.workers) await applyWorkerSettings(tx, actor, change.workers);
    if (change.mfa) await applyAuthPolicy(tx, actor, change.mfa);
    return { kind: 'DONE' };
  },
  liveObjects: async () => [SETTINGS_OBJECT_ID],
  title(p: ProposalRow) {
    const sections = SETTINGS_SECTIONS.filter((s) => (p.payload as SettingsChange)[s] !== undefined);
    const detail = describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot));
    return `Change ${sections.join(', ')} settings${detail ? `: ${detail}` : ''}`;
  },
};
