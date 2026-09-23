import { asc, eq } from 'drizzle-orm';
import { tools, type DbOrTx } from '@ocso/db';
import { validation } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import { assertPlatformWrite } from '../settings/platform-approvals.js';
import { assertCanAdminister } from './access.js';
import { policyProblems, writeConnectionPolicy, writeToolClassification } from './connection-apply.js';
import { connectionDisabled } from './errors.js';
import { ApproveConnectionInput, ClassifyToolsInput } from './inputs.js';
import { isPersonal, loadConnection, type McpContext } from './records.js';
import { toToolView, viewOf, type ConnectionView, type ToolView } from './views.js';

/**
 * Wizard steps 4 "Review capabilities" and 5 "Approve". The admin's
 * classification is authoritative; server annotations only seeded it.
 *
 * Maker–checker (PM/research/11 §4): these are the direct writes of a draft
 * connection — one never approved. Once a connection has been approved they
 * answer 409 approval_required and the change travels as an UPDATE proposal
 * (connection-approval.ts); taking a draft live is an ACTIVATE proposal, so
 * "approve" here only records the agent policy the checker will see.
 */
export class ConnectionReview {
  constructor(private readonly ctx: McpContext) {}

  async classifyTools(actor: ActorContext, connectionId: string, raw: ClassifyToolsInput): Promise<ToolView[]> {
    const input = ClassifyToolsInput.parse(raw);
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (tx) => {
      await this.gate(tx, actor, connectionId);
      const conn = await loadConnection(tx, connectionId, { lock: true });
      await writeToolClassification(tx, actor, conn, input.tools, now);
      const all = await tx.select().from(tools).where(eq(tools.connectionId, connectionId)).orderBy(asc(tools.name));
      return all.map(toToolView);
    });
  }

  /** Records the agent policy of a draft connection (the ACTIVATE proposal takes it live). */
  async approve(actor: ActorContext, connectionId: string, raw: ApproveConnectionInput): Promise<ConnectionView> {
    const input = ApproveConnectionInput.parse(raw);
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (tx) => {
      await this.gate(tx, actor, connectionId);
      const conn = await loadConnection(tx, connectionId, { lock: true });
      if (conn.status === 'DISABLED') throw connectionDisabled(connectionId);
      const problems = await policyProblems(tx, conn, input);
      if (problems.length) throw validation(problems[0]!.code, problems.map((p) => p.message).join(' '));
      return viewOf(tx, await writeConnectionPolicy(tx, actor, conn, input, { now }));
    });
  }

  /** Administer (shared or template) and hold the connection's approval lock: a draft only (else 409). */
  private async gate(tx: DbOrTx, actor: ActorContext, connectionId: string): Promise<void> {
    const conn = await loadConnection(tx, connectionId);
    assertCanAdminister(actor, conn);
    if (!isPersonal(conn)) await assertPlatformWrite(tx, 'mcp_connection', connectionId);
  }
}
