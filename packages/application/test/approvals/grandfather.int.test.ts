import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, runMigrations, uuidv7, type Database } from '@ocso/db';
import { MIGRATIONS_DIR, testAdminUrl } from '@ocso/db/testing';
import { createApprovalRegistry } from '../../src/approvals/composition.js';

/**
 * Grandfather (0031_approvals_grandfather, PM/research/11b): a deployment that predates maker-checker, with
 * live objects of every approvable kind, upgrades with every one of them recorded as approved — so no live
 * object is "live without approval" and the next change to any of them is a proposal.
 */
const GRANDFATHER = '0031_approvals_grandfather.sql';
const name = `ocso_test_${randomBytes(6).toString('hex')}`;
let database: Database;
let before: string;
const id = Object.fromEntries(
  ['team', 'head', 'service', 'disabled', 'maya', 'draftAgent', 'prompt', 'escalation', 'businessAlert', 'techAlert', 'channel', 'idleChannel', 'template', 'router', 'routerVersion', 'offRouter', 'queue', 'sla', 'provider', 'profile', 'unusedProfile', 'pricing', 'mcp', 'destination', 'webhook', 'sso'].map((k) => [k, uuidv7()]),
) as Record<string, string>;

async function adminQuery(text: string): Promise<void> {
  const admin = createDatabase({ connectionString: testAdminUrl(), maxConnections: 1, applicationName: 'ocso-test' });
  try {
    await admin.pool.query(text);
  } finally {
    await admin.close();
  }
}
const q = (text: string, params: unknown[] = []) => database.pool.query(text, params);

beforeAll(async () => {
  await adminQuery(`CREATE DATABASE ${name}`);
  const url = new URL(testAdminUrl());
  url.pathname = `/${name}`;
  database = createDatabase({ connectionString: url.toString(), maxConnections: 2, applicationName: 'ocso-test' });
  before = await mkdtemp(join(tmpdir(), 'ocso-migrations-'));
  for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql') && f < GRANDFATHER)) await copyFile(join(MIGRATIONS_DIR, file), join(before, file));
  await runMigrations(database.pool, before);

  // A live pre-release deployment: one of everything.
  await q(`INSERT INTO teams (id, name) VALUES ($1, 'Cards')`, [id.team]);
  await q(
    `INSERT INTO users (id, email, name, role, status) VALUES ($1, 'head@bank.test', 'Hema', 'HEAD', 'ACTIVE'), ($2, 'svc@bank.test', 'Sam', 'SERVICE', 'ACTIVE'), ($3, 'gone@bank.test', 'Gus', 'SERVICE', 'DISABLED')`,
    [id.head, id.service, id.disabled],
  );
  await q(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)`, [id.team, id.head, id.service]);
  await q(`INSERT INTO model_providers (id, kind, name, enabled) VALUES ($1, 'OPENAI', 'OpenAI', true)`, [id.provider]);
  await q(`INSERT INTO model_profiles (id, name, provider_id, model) VALUES ($1, 'Fast', $3, 'gpt-x'), ($2, 'Spare', $3, 'gpt-y')`, [id.profile, id.unusedProfile, id.provider]);
  await q(`INSERT INTO model_pricing (id, provider_kind, model_pattern, input_per_m_tok_micros, output_per_m_tok_micros, origin, status) VALUES ($1, 'OPENAI', 'gpt-x', 1, 2, 'manual', 'ACTIVE')`, [id.pricing]);
  await q(`INSERT INTO sla_policies (id, name) VALUES ($1, 'Cards SLA')`, [id.sla]);
  await q(`INSERT INTO queues (id, name, sla_policy_id) VALUES ($1, 'Cards', $2)`, [id.queue, id.sla]);
  await q(`INSERT INTO queue_teams (queue_id, team_id) VALUES ($1, $2)`, [id.queue, id.team]);
  await q(`INSERT INTO virtual_agents (id, name, slug, conversation_type, status, model_profile_id, default_queue_id) VALUES ($1, 'Maya', 'maya', 'SUPPORT', 'LIVE', $3, $4), ($2, 'Draft', 'draft', 'SUPPORT', 'DRAFT', NULL, NULL)`, [
    id.maya,
    id.draftAgent,
    id.profile,
    id.queue,
  ]);
  await q(`INSERT INTO agent_teams (agent_id, team_id) VALUES ($1, $2)`, [id.maya, id.team]);
  await q(
    `INSERT INTO prompt_versions (id, agent_id, version, components, component_hashes, prompt_hash, runtime_contract_version, changed_components, reason) VALUES ($1, $2, 1, '{}', '{}', 'h', '1', '{}', 'first')`,
    [id.prompt, id.maya],
  );
  await q(`UPDATE virtual_agents SET active_prompt_version_id = $1 WHERE id = $2`, [id.prompt, id.maya]);
  await q(`INSERT INTO escalation_rules (id, agent_id, name, trigger, target_queue_id, enabled) VALUES ($1, $2, 'Angry', 'SENTIMENT', $3, true)`, [id.escalation, id.maya, id.queue]);
  await q(
    `INSERT INTO alert_rules (id, name, kind, condition, audience_roles, agent_id, enabled) VALUES ($1, 'CSAT dip', 'BUSINESS', 'CSAT_BELOW', '{HEAD}', $3, true), ($2, 'Worker lag', 'TECHNICAL', 'QUEUE_AGE', '{TECH}', NULL, true)`,
    [id.businessAlert, id.techAlert, id.maya],
  );
  await q(`INSERT INTO channels (id, kind, name, public_key, status, default_agent_id) VALUES ($1, 'WHATSAPP_TWILIO', 'WhatsApp', 'pk1', 'ACTIVE', $3), ($2, 'WEB', 'Idle web', 'pk2', 'DISABLED', NULL)`, [
    id.channel,
    id.idleChannel,
    id.maya,
  ]);
  await q(
    `INSERT INTO message_templates (id, channel_id, provider_template_id, name, language, category, status, definition) VALUES ($1, $2, 'HX0000000000000000000000000000000a', 'welcome', 'en', 'UTILITY', 'APPROVED', '{}')`,
    [id.template, id.channel],
  );
  await q(`INSERT INTO routers (id, name, status) VALUES ($1, 'WhatsApp', 'ACTIVE'), ($2, 'Old', 'DISABLED')`, [id.router, id.offRouter]);
  await q(`INSERT INTO router_versions (id, router_id, version, definition) VALUES ($1, $2, 1, $3)`, [
    id.routerVersion,
    id.router,
    JSON.stringify({ kind: 'PASS_THROUGH', fallbackQueueId: id.queue, steps: [{ kind: 'CLASSIFY', modelProfileId: id.profile }] }),
  ]);
  await q(`UPDATE routers SET active_version_id = $1 WHERE id = $2`, [id.routerVersion, id.router]);
  await q(`UPDATE channels SET router_id = $1 WHERE id = $2`, [id.router, id.channel]);
  await q(`INSERT INTO mcp_connections (id, name, url, status, approved_at) VALUES ($1, 'Core banking', 'https://mcp.bank.test', 'ACTIVE', now())`, [id.mcp]);
  await q(`INSERT INTO notification_destinations (id, name, kind, enabled) VALUES ($1, 'Ops email', 'EMAIL', true)`, [id.destination]);
  await q(`INSERT INTO webhook_subscriptions (id, name, url, events, signing_secret_ref, enabled) VALUES ($1, 'SIEM', 'https://siem.bank.test', '{conversation.resolved}', 'ref', true)`, [id.webhook]);
  await q(`INSERT INTO auth_sso_providers (id, issuer, provider_id, domain, status) VALUES ($1, 'https://idp.bank.test', 'bank', 'bank.test', 'ACTIVE')`, [id.sso]);

  await runMigrations(database.pool, MIGRATIONS_DIR);
}, 120_000);

afterAll(async () => {
  await database?.close();
  if (before) await rm(before, { recursive: true, force: true });
  await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

async function approved(): Promise<Map<string, Set<string>>> {
  const { rows } = await q(`SELECT object_kind, object_id FROM approval_proposals WHERE status = 'APPROVED'`);
  const out = new Map<string, Set<string>>();
  for (const r of rows as Array<{ object_kind: string; object_id: string }>) out.set(r.object_kind, (out.get(r.object_kind) ?? new Set()).add(r.object_id));
  return out;
}

describe('0031 grandfathers live configuration', () => {
  it('leaves no live object of any kind without an approval', async () => {
    const registry = createApprovalRegistry();
    const byKind = await approved();
    const missing: string[] = [];
    let live = 0;
    for (const kind of registry.kinds()) {
      for (const objectId of await registry.get(kind).liveObjects(database.db)) {
        live++;
        if (!byKind.get(kind)?.has(objectId)) missing.push(`${kind}:${objectId}`);
      }
    }
    expect(missing).toEqual([]);
    // The fixture really is live on every kind the migration covers (the check above is not vacuous).
    expect(live).toBeGreaterThanOrEqual(18);
  });

  it('records each row honestly: origin MIGRATION, approved and activated, no maker or checker', async () => {
    const { rows } = await q(`SELECT DISTINCT origin, status, maker_id, checker_id, bootstrap, activated_at IS NOT NULL AS activated FROM approval_proposals`);
    expect(rows).toEqual([{ origin: 'MIGRATION', status: 'APPROVED', maker_id: null, checker_id: null, bootstrap: false, activated: true }]);
  });

  it('covers the supersets the owning areas asked for, and leaves drafts drafts', async () => {
    const byKind = await approved();
    expect(byKind.get('router')).toEqual(new Set([id.router, id.offRouter]));
    expect(byKind.get('user')).toEqual(new Set([id.head, id.service, id.disabled]));
    expect(byKind.get('model_profile')).toEqual(new Set([id.profile, id.unusedProfile]));
    expect(byKind.get('agent')).toEqual(new Set([id.maya]));
    expect(byKind.get('channel')).toEqual(new Set([id.channel]));
    expect(byKind.get('alert_rule_technical')).toEqual(new Set([id.techAlert]));
    expect(byKind.has('permission_change')).toBe(false);
    const { rows } = await q(`SELECT team_ids FROM approval_proposals WHERE object_kind = 'agent'`);
    expect(rows[0].team_ids).toEqual([id.team]);
  });
});
