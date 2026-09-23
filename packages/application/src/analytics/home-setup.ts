import { sql } from 'drizzle-orm';
import { APPROVAL_CHECK_PERMISSIONS } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { holdsPermissionSql } from '../identity/permissions/state.js';
import { CHANNEL_AGENT_REACH } from '../routing/reach.js';

export type SetupStepKey = 'model' | 'agent' | 'channel' | 'second_checker' | 'go_live' | 'ask_ocso';

export interface HomeSetup {
  complete: boolean;
  steps: Array<{ key: SetupStepKey; label: string; done: boolean; href: string }>;
}

/**
 * The setup checklist on a new deployment (HOME decision 5), in the order a
 * deployment comes alive. Each step is read from live state, never stored:
 * - model: a model profile on an enabled provider
 * - agent: a virtual agent exists
 * - channel: an ACTIVE channel
 * - second_checker: two ACTIVE people can approve changes (maker–checker needs someone other than the maker)
 * - go_live: a LIVE agent that an ACTIVE channel reaches through an ACTIVE router
 * - ask_ocso: a model profile chosen for Ask OCSO
 */
export async function homeSetup(db: Db, askOcsoConfigured: boolean): Promise<HomeSetup> {
  const checker = sql.join(APPROVAL_CHECK_PERMISSIONS.map((p) => holdsPermissionSql(p)), sql` OR `);
  const { rows } = await db.execute<{ model: boolean; agent: boolean; channel: boolean; checkers: number; live: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM model_profiles mp JOIN model_providers pr ON pr.id = mp.provider_id WHERE pr.enabled) AS model,
           EXISTS (SELECT 1 FROM virtual_agents) AS agent,
           EXISTS (SELECT 1 FROM channels WHERE status = 'ACTIVE') AS channel,
           (SELECT count(*)::int FROM (SELECT 1 FROM users WHERE users.status = 'ACTIVE' AND (${checker}) LIMIT 2) x) AS checkers,
           EXISTS (SELECT 1 FROM (${CHANNEL_AGENT_REACH}) AS reach
                     JOIN channels ch ON ch.id = reach.channel_id AND ch.status = 'ACTIVE'
                     JOIN virtual_agents a ON a.id = reach.agent_id AND a.status = 'LIVE') AS live`);
  const r = rows[0];
  const steps: HomeSetup['steps'] = [
    { key: 'model', label: 'Connect a model provider and create a model profile', done: Boolean(r?.model), href: '/connections?tab=providers' },
    { key: 'agent', label: 'Create your first agent', done: Boolean(r?.agent), href: '/agents' },
    { key: 'channel', label: 'Open a channel customers can reach', done: Boolean(r?.channel), href: '/connections?tab=channels' },
    { key: 'second_checker', label: 'Add a second person who can approve changes', done: Number(r?.checkers ?? 0) >= 2, href: '/team' },
    { key: 'go_live', label: 'Route a channel to a live agent', done: Boolean(r?.live), href: '/routers' },
    { key: 'ask_ocso', label: 'Choose the model Ask OCSO runs on', done: askOcsoConfigured, href: '/settings' },
  ];
  return { complete: steps.every((s) => s.done), steps };
}
