import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@ocso/auth';
import { InternalToolRegistry, type ToolContext } from '../src/index.js';
import { createOwnershipFixture, type OwnershipFixture } from '../../application/test/support/ownership-fixture.js';

/**
 * Ask OCSO inherits team-scoped agent ownership (ADR-026): its tools call the
 * application services with the asking user's principal, so a CS Lead only
 * sees and changes the agents their teams own.
 */

let f: OwnershipFixture;
const registry = new InternalToolRegistry();
beforeAll(async () => {
  f = await createOwnershipFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

const ctx = (principal: Principal): ToolContext => ({ db: f.t.db, principal: { ...principal, via: 'INTERNAL_AGENT' }, actor: { principal: { ...principal, via: 'INTERNAL_AGENT' }, correlationId: 'ask' }, now: new Date() });
const run = async (principal: Principal, name: string, args: unknown) => {
  const { tool, args: parsed } = registry.resolve(principal, name, args);
  return tool.run(ctx(principal), parsed);
};

describe('internal agent tools and agent ownership', () => {
  it('agent_performance lists only the lead’s agents', async () => {
    const names = async (p: Principal) => ((await run(p, 'agent_performance', {})).data as Array<{ name: string }>).map((a) => a.name).sort();
    expect(await names(f.p.leadA)).toEqual(['Maya', 'Sana']);
    expect(await names(f.p.leadB)).toEqual(['Arjun', 'Sana']);
  });

  it('set_agent_status cannot preview or change another team’s agent', async () => {
    const { tool, args } = registry.resolve(f.p.leadB, 'set_agent_status', { agentId: f.agent.maya, status: 'PAUSED' });
    expect(await tool.preview!(ctx(f.p.leadB), args)).toEqual({ changes: [] });
    await expect(tool.run(ctx(f.p.leadB), args)).rejects.toMatchObject({ category: 'not_found' });
    const own = registry.resolve(f.p.leadA, 'set_agent_status', { agentId: f.agent.maya, status: 'PAUSED' });
    expect((await own.tool.preview!(ctx(f.p.leadA), own.args)).changes).toEqual([{ label: 'Maya · status', before: 'DRAFT', after: 'PAUSED' }]);
  });

  it('list_conversations and attention_summary follow the lead’s conversation scope', async () => {
    const ids = async (p: Principal) => ((await run(p, 'list_conversations', { view: 'all' })).data as { conversations: Array<{ id: string }> }).conversations.map((c) => c.id).sort();
    expect(await ids(f.p.leadB)).toEqual([f.conv.c2, f.conv.c3].sort());
    await expect(run(f.p.leadB, 'get_conversation', { conversationId: f.conv.c1 })).rejects.toMatchObject({ category: 'authorization' });
    const attention = JSON.stringify((await run(f.p.leadB, 'attention_summary', {})).data);
    expect(attention).not.toContain('Priya Deshmukh'); // c1 (Maya, Cards only)
  });
});
