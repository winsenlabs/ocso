import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { approvalProposals, deploymentSettings, users, type Db } from '@ocso/db';
import { describeDiff } from '@ocso/domain';
import { EmailSendError, approvalEmail, type ApprovalEmailKind, type EmailSender } from '@ocso/email';
import { loadPerson } from './access.js';
import type { ApprovalRegistry } from './registry.js';
import { proposalDiff } from './records.js';

export type ApprovalNoticeKind = 'REQUESTED' | 'DECIDED' | 'CHECKER_INVALID';
export interface ApprovalNotifyJob {
  proposalId: string;
  kind: ApprovalNoticeKind;
}

export interface ApprovalNotifierDeps {
  db: Db;
  registry: ApprovalRegistry;
  email: EmailSender;
  /** OCSO_PUBLIC_URL, for the "Open in OCSO" link; omitted when unset. */
  baseUrl?: string | null | undefined;
}

/**
 * Email side of approval notifications (topic approval.notify). The in-app
 * side is the realtime event emitted in the decision's own transaction. A
 * retriable send failure is thrown so the queue retries; the checker email
 * stamps `notified_at` so the redispatch sweep stops.
 */
export class ApprovalNotifier {
  constructor(private readonly deps: ApprovalNotifierDeps) {}

  async handle(job: ApprovalNotifyJob): Promise<'sent' | 'skipped'> {
    const { db } = this.deps;
    const [p] = await db.select().from(approvalProposals).where(eq(approvalProposals.id, job.proposalId));
    if (!p) return 'skipped';
    const ids = [p.makerId, p.checkerId, p.decidedBy].filter((x): x is string => Boolean(x));
    const people = new Map((await db.select({ id: users.id, name: users.name, email: users.email, status: users.status }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u]));
    const maker = p.makerId ? people.get(p.makerId) : undefined;
    const checker = p.checkerId ? people.get(p.checkerId) : undefined;
    let kind: ApprovalEmailKind;
    let to: string[];
    if (job.kind === 'REQUESTED') {
      if (p.status !== 'SUBMITTED' || p.notifiedAt || p.checkerId === p.makerId) return 'skipped';
      if (!checker || checker.status !== 'ACTIVE') {
        // Nobody to email: stamp it so the redispatch sweep stops (the checker sweep flags the proposal instead).
        await this.stampNotified(p);
        return 'skipped';
      }
      kind = 'REQUESTED';
      to = [checker.email];
    } else if (job.kind === 'DECIDED') {
      if (p.status === 'SUBMITTED') return 'skipped';
      kind = p.status === 'APPROVED' ? 'APPROVED' : p.status;
      const recipient = p.status === 'WITHDRAWN' ? checker : maker;
      if (!recipient || recipient.status !== 'ACTIVE' || recipient.id === p.decidedBy) return 'skipped';
      to = [recipient.email];
    } else {
      if (p.status !== 'SUBMITTED' || p.checkerValid) return 'skipped';
      kind = 'CHECKER_INVALID';
      to = [...(await this.reassigners()), ...(maker && maker.status === 'ACTIVE' ? [maker.email] : [])];
    }
    if (!to.length) return 'skipped';
    const label = this.deps.registry.has(p.objectKind) ? this.deps.registry.get(p.objectKind).label : p.objectKind;
    const [settings] = await db.select({ org: deploymentSettings.orgName }).from(deploymentSettings).limit(1);
    const base = this.deps.baseUrl?.replace(/\/+$/, '');
    const rendered = approvalEmail({
      org: settings?.org ?? 'OCSO',
      kind,
      title: p.title,
      objectLabel: label,
      makerName: maker?.name ?? 'Migration',
      checkerName: checker?.name ?? null,
      reason: job.kind === 'REQUESTED' ? p.reason : p.decisionReason ?? p.blockedReason,
      changes: describeDiff(proposalDiff(p)),
      link: base ? `${base}/approvals?approval=${p.id}` : null,
      reference: `Proposal ${p.id} · revision ${p.revision}`,
    });
    try {
      await this.deps.email.send({
        to: [...new Set(to)],
        ...rendered,
        tags: { kind: 'approval' },
        idempotencyKey: `approval:${p.id}:${kind}:${p.revision}:${p.checkerId ?? ''}`,
      });
    } catch (err) {
      // A refusal that will never succeed is stamped, so the redispatch sweep does not resend it every 5 minutes.
      if (job.kind === 'REQUESTED' && err instanceof EmailSendError && !err.retriable) await this.stampNotified(p);
      throw err;
    }
    if (job.kind === 'REQUESTED') await this.stampNotified(p);
    return 'sent';
  }

  /**
   * Stamp only the request this job was about: same checker, same revision, not yet stamped. A reassignment
   * racing this job resets notified_at for the new checker, and this stamp must not swallow that email.
   */
  private async stampNotified(p: typeof approvalProposals.$inferSelect): Promise<void> {
    await this.deps.db
      .update(approvalProposals)
      .set({ notifiedAt: new Date() })
      .where(
        and(
          eq(approvalProposals.id, p.id),
          p.checkerId ? eq(approvalProposals.checkerId, p.checkerId) : isNull(approvalProposals.checkerId),
          eq(approvalProposals.revision, p.revision),
          isNull(approvalProposals.notifiedAt),
        ),
      );
  }

  /** ACTIVE holders of approvals.reassign_any (effective permissions). */
  private async reassigners(): Promise<string[]> {
    const active = await this.deps.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.status, 'ACTIVE'));
    const out: string[] = [];
    for (const u of active) {
      const person = await loadPerson(this.deps.db, u.id);
      if (person && can(person, Permission.APPROVALS_REASSIGN_ANY)) out.push(u.email);
    }
    return out;
  }
}
