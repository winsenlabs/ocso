import { and, eq, isNull } from 'drizzle-orm';
import { SETTINGS_OBJECT_ID, type ActorContext, type ClassifyToolsInput, type SetAgentToolGrantsInput } from '@ocso/application';
import { mcpConnections } from '@ocso/db';
import type { SeedContext } from '../context.js';
import { approveAs, approveProposal, unfinishedProposal } from './agents.js';

export const MCP_CONNECTION_NAME = 'meridian-core';

type Risk = 'READ' | 'WRITE' | 'SENSITIVE';

/** Tool classification the Tech admin approves (examples/mcp-bank-demo README). */
const CLASSIFICATION: Record<string, Risk> = {
  'crm.get_customer': 'READ',
  'cards.list_transactions': 'READ',
  'emi.get_schedule': 'READ',
  'knowledge.search_policy': 'READ',
  'statements.send_pdf': 'WRITE',
  'disputes.raise_case': 'WRITE',
  'payments.reverse_transaction': 'SENSITIVE',
};

/** What the Lead grants Maya: every read tool plus two write tools. */
const MAYA_GRANTS = new Set(['crm.get_customer', 'cards.list_transactions', 'emi.get_schedule', 'knowledge.search_policy', 'disputes.raise_case', 'payments.reverse_transaction']);

/**
 * ₹5,000 authority limit (design/01, design/02). The demo server takes
 * `amountMinor` in paise, so the rule is expressed on that argument; argument
 * rule paths are checked against the tool's input schema.
 */
const REVERSAL_RULE = { path: 'amountMinor', op: 'gt' as const, value: 500_000, effect: 'REQUIRE_CONFIRMATION' as const, message: 'Reversals above ₹5,000 need a human confirmation' };

async function allowInternalHost(ctx: SeedContext, admin: ActorContext, checker: ActorContext, host: string): Promise<void> {
  const settings = await ctx.services.settings.deployment();
  if (settings.egressAllowedInternalHosts.includes(host)) return;
  const deployment = { egressAllowedInternalHosts: [...settings.egressAllowedInternalHosts, host] };
  await approveAs(ctx, admin, checker, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', payload: { deployment } }, 'Demo seed: allow the demo MCP host');
  ctx.log(`allowlisted internal MCP host ${host} (egress policy)`);
}

async function ensureDraft(ctx: SeedContext, admin: ActorContext, url: string): Promise<typeof mcpConnections.$inferSelect> {
  const find = () => ctx.db.select().from(mcpConnections).where(and(eq(mcpConnections.name, MCP_CONNECTION_NAME), isNull(mcpConnections.ownerUserId)));
  const [existing] = await find();
  if (existing) return existing;
  await ctx.services.mcp.createDraft(admin, {
    name: MCP_CONNECTION_NAME,
    description: 'Meridian core banking (demo): customers, cards, EMI, statements, disputes, payments',
    url,
    network: 'INTERNAL',
    scope: 'SHARED',
  });
  const [created] = await find();
  return created!;
}

/** Wizard steps 2–5: discover, authenticate with a header token, classify, approve for Maya. */
async function connectAndApprove(ctx: SeedContext, admin: ActorContext, checker: ActorContext, connectionId: string, token: string, mayaId: string): Promise<void> {
  let outcome = await ctx.services.mcp.discover(admin, connectionId);
  if (outcome.outcome === 'AUTH_REQUIRED') {
    // The demo server is a bearer-token resource server without OAuth metadata.
    outcome = await ctx.services.mcp.setHeaderAuth(admin, connectionId, { headerName: 'Authorization', token: `Bearer ${token}` });
  }
  if (outcome.outcome !== 'DISCOVERED') throw new Error(`MCP discovery did not complete (status ${outcome.connection.status})`);
  ctx.log(`discovered ${outcome.tools.total} tools on ${MCP_CONNECTION_NAME}`);

  const discovered = await ctx.services.mcp.listTools(admin, connectionId);
  const tools: ClassifyToolsInput['tools'] = discovered
    .filter((t) => CLASSIFICATION[t.name])
    .map((t) => ({
      toolId: t.id,
      riskClass: CLASSIFICATION[t.name]!,
      approved: true,
      ...(CLASSIFICATION[t.name] === 'SENSITIVE' ? { humanRoles: ['SERVICE', 'HEAD'] as Array<'SERVICE' | 'HEAD'> } : {}),
    }));
  const missing = Object.keys(CLASSIFICATION).filter((name) => !discovered.some((t) => t.name === name));
  if (missing.length) ctx.log(`warning: demo MCP server did not list ${missing.join(', ')}`);
  await ctx.services.mcp.classifyTools(admin, connectionId, { tools });
  await ctx.services.mcp.approve(admin, connectionId, { allowedAgentIds: [mayaId], confirmationPolicy: 'SENSITIVE_ONLY', sendCustomerClaims: false, healthCheckSeconds: 60 });
  // Going live is an approval (a Head checks the Tech admin's connection); activation re-contacts the server,
  // which the seed finishes itself instead of waiting for the worker.
  const unfinished = await unfinishedProposal(ctx, 'mcp_connection', connectionId, 'ACTIVATE');
  if (unfinished) {
    await approveProposal(ctx, checker, unfinished.id);
  } else {
    const proposal = await ctx.services.approvals.submit(admin, { objectKind: 'mcp_connection', objectId: connectionId, action: 'ACTIVATE', checkerId: checker.principal!.userId, reason: 'Demo seed: connect core banking for Maya' });
    await ctx.services.approvalDecisions.decide(checker, proposal.id, { decision: 'APPROVE', reason: 'Demo seed: reviewed', contentHash: proposal.contentHash });
    const activation = await ctx.services.approvalDecisions.finishActivation(checker, proposal.id);
    if (activation !== 'ACTIVATED') throw new Error(`MCP activation ${activation.toLowerCase()}`);
  }
  ctx.log(`approved ${MCP_CONNECTION_NAME} for Maya (${tools.length} tools classified)`);
}

async function grantMaya(ctx: SeedContext, lead: ActorContext, connectionId: string, mayaId: string, checker: ActorContext | undefined): Promise<void> {
  const tools = await ctx.services.mcp.listTools(lead, connectionId);
  const grants: SetAgentToolGrantsInput['grants'] = tools
    .filter((t) => t.approved && MAYA_GRANTS.has(t.name))
    .map((t) => ({ toolId: t.id, enabled: true, alwaysConfirm: false, argumentRules: t.name === 'payments.reverse_transaction' ? [REVERSAL_RULE] : [] }));
  // Maya is live: granting tools widens what she may do, so it is an agent_tool_grant proposal the other Head checks.
  const change = await ctx.services.toolGrants.replace(lead, mayaId, { grants });
  if (change.proposed) {
    if (!checker) throw new Error('granting tools to a live agent needs a checker');
    await approveAs(ctx, lead, checker, { objectKind: 'agent_tool_grant', objectId: mayaId, action: 'UPDATE', payload: { grants: change.proposed } }, 'Demo seed: grant Maya her tools');
  }
  ctx.log(`granted Maya ${grants.length} tools (payments.reverse_transaction: amountMinor > 500000 ⇒ REQUIRE_CONFIRMATION)`);
}

export type McpSeedResult = 'connected' | 'skipped' | 'failed';

/**
 * Connects the demo MCP server when MCP_DEMO_URL/DEMO_MCP_TOKEN are set. Any
 * failure is reported and skipped: the rest of the demo stays usable and the
 * connection can be finished from Integrations → MCP connections in the UI.
 */
export async function seedMcp(ctx: SeedContext, admin: ActorContext, lead: ActorContext, mayaId: string, checker?: ActorContext): Promise<McpSeedResult> {
  const mcp = ctx.config.mcp;
  if (!mcp) {
    ctx.log('MCP_DEMO_URL / DEMO_MCP_TOKEN not set — skipping the demo MCP connection');
    return 'skipped';
  }
  try {
    await allowInternalHost(ctx, admin, lead, new URL(mcp.url).hostname);
    const conn = await ensureDraft(ctx, admin, mcp.url);
    if (!conn.approvedAt) await connectAndApprove(ctx, admin, lead, conn.id, mcp.token, mayaId);
    await grantMaya(ctx, lead, conn.id, mayaId, checker);
    return 'connected';
  } catch (err) {
    ctx.log(`warning: demo MCP connection not completed: ${(err as Error).message}`);
    return 'failed';
  }
}
