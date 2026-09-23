import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { approvalCounts, approvalKinds, getApproval, listApprovals, reassignCandidates } from '@/lib/api/approvals';
import { ApiError } from '@/lib/api/errors';
import { hasPermission, type Session } from '@/lib/session';
import { ApprovalDrawer } from './approval-drawer';
import { ApprovalsTable } from './approvals-table';
import { approvalsHref, toApiQuery, type ApprovalsParams } from './approvals-meta';
import type { ProposalDetail } from './lib/schemas';

async function detailOrNull(id: string): Promise<ProposalDetail | null> {
  try {
    return await getApproval(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

function Chip({ href, on, children, count }: { href: string; on: boolean; children: string; count?: number | undefined }) {
  return (
    <Link className={on ? 'fchip active' : 'fchip'} aria-current={on ? 'true' : undefined} href={href} scroll={false}>
      {children}
      {count !== undefined ? <span className="fchip-count">{count}</span> : null}
    </Link>
  );
}

const EMPTY: Record<string, { title: string; body: string }> = {
  AWAITING_ME: { title: 'Nothing is waiting for your decision.', body: 'Changes you are named checker for appear here, with a diff of what would change.' },
  SENT_BY_ME: { title: 'You have not submitted a change yet.', body: 'When a change to live configuration needs approval, you name a checker and it appears here.' },
  OPEN: { title: 'No open proposals.', body: 'Every change is decided. Proposals whose checker lost their rights would show here.' },
  DECIDED: { title: 'No decided proposals yet.', body: 'Approved, rejected, withdrawn and blocked changes you can see are listed here.' },
};

/** The approval queue for one tab: kind chips with counts, the table with bulk approve, and the drawer. */
export async function ApprovalsInbox({ session, params }: { session: Session; params: ApprovalsParams }) {
  const box = params.box ?? 'AWAITING_ME';
  const [counts, kinds, page, detail] = await Promise.all([
    approvalCounts(),
    approvalKinds(),
    listApprovals(toApiQuery(params)),
    params.approval ? detailOrNull(params.approval) : Promise.resolve(null),
  ]);
  const candidates = detail?.canReassign ? await reassignCandidates(detail.id).catch(() => []) : [];
  const base: ApprovalsParams = { box, kind: params.kind, needsChecker: params.needsChecker };
  const boxCount: Partial<Record<string, number>> = { AWAITING_ME: counts.awaitingMe, SENT_BY_ME: counts.sentByMe, OPEN: counts.open };
  const empty = EMPTY[box]!;

  return (
    <>
      <div className="ap-filters" aria-label="Approval filters">
        <div className="grp" role="group" aria-label="Kind">
          <Chip href={approvalsHref({ ...base, kind: undefined })} on={!params.kind} count={boxCount[box]}>
            All kinds
          </Chip>
          {kinds.map((k) => (
            <Chip key={k.kind} href={approvalsHref({ ...base, kind: k.kind })} on={params.kind === k.kind}>
              {k.label}
            </Chip>
          ))}
        </div>
        {box === 'OPEN' ? (
          <div className="grp" role="group" aria-label="Checker">
            <Chip href={approvalsHref({ ...base, needsChecker: params.needsChecker ? undefined : true })} on={Boolean(params.needsChecker)} count={counts.needsChecker}>
              Needs a new checker
            </Chip>
          </div>
        ) : null}
      </div>

      {params.approval && !detail ? (
        <AlertBanner tone="warn" title="Proposal not available">
          It does not exist or concerns objects outside your teams.
        </AlertBanner>
      ) : null}

      <ApprovalsTable
        rows={page.rows}
        meId={session.user.id}
        canCheck={box === 'AWAITING_ME'}
        selectedId={detail?.id ?? null}
        linkParams={{ ...base, before: params.before, beforeId: params.beforeId }}
        empty={<EmptyState title={empty.title}>{empty.body}</EmptyState>}
      />
      <div className="rowsplit" style={{ marginTop: 10 }}>
        {params.before ? (
          <Link className="btn tiny ghost" href={approvalsHref(base)} scroll={false}>
            ← Newest
          </Link>
        ) : null}
        <span className="sp" />
        {page.next ? (
          <Link className="btn tiny ghost" href={approvalsHref({ ...base, before: page.next.before, beforeId: page.next.beforeId })} scroll={false}>
            Older →
          </Link>
        ) : null}
      </div>

      {detail ? (
        <ApprovalDrawer
          key={`${detail.id}-${detail.status}-${detail.revision}-${detail.checker?.id ?? ''}`}
          proposal={detail}
          candidates={candidates}
          reassignAny={hasPermission(session, Permission.APPROVALS_REASSIGN_ANY)}
          timeZone={session.user.deployment.timezone}
          closeHref={approvalsHref({ ...base, before: params.before, beforeId: params.beforeId })}
        />
      ) : null}
    </>
  );
}
