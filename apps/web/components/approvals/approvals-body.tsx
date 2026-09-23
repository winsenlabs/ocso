import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { LiveRefresh } from '@/components/system/live-refresh';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { hasPermission, requireSession } from '@/lib/session';
import { BOX_LABELS, approvalsHref, parseApprovalsParams, type ApprovalBox } from './approvals-meta';
import { ApprovalsInbox } from './approvals-inbox';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /approvals (PM/research/11b "ui"): tabs Awaiting me · Sent by me · All open
 * (approvals.reassign_any) · Decided. Tab, filters, cursor and the open drawer
 * live in the URL; realtime approval events re-read the page.
 */
export async function ApprovalsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, raw] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.APPROVALS_READ)) return <NotPermitted role={session.roleLabel} />;
  const params = parseApprovalsParams(raw);
  const boxes: ApprovalBox[] = ['AWAITING_ME', 'SENT_BY_ME', ...(hasPermission(session, Permission.APPROVALS_REASSIGN_ANY) ? (['OPEN'] as const) : []), 'DECIDED'];
  const box = boxes.includes(params.box ?? 'AWAITING_ME') ? (params.box ?? 'AWAITING_ME') : 'AWAITING_ME';
  return (
    <>
      <Tabs
        label="Approval views"
        idBase="approvals"
        active={box}
        items={boxes.map((b) => ({ key: b, label: BOX_LABELS[b], href: approvalsHref({ box: b }) }))}
        trailing={<LiveRefresh events={['approval.requested', 'approval.decided', 'approval.checker_invalid']} />}
      />
      <TabPanel idBase="approvals" active={box}>
        <div style={{ paddingTop: 14 }}>
          <ApprovalsInbox session={session} params={{ ...params, box }} />
        </div>
      </TabPanel>
    </>
  );
}
