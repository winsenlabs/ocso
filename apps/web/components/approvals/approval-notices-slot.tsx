import { Permission } from '@ocso/auth';
import { getSession, hasPermission } from '@/lib/session';
import { ApprovalNotices } from './approval-notices';

/** Mounted once in the app frame: whoever may read approvals hears about theirs. */
export async function ApprovalNoticesSlot() {
  const session = await getSession();
  if (!session || !hasPermission(session, Permission.APPROVALS_READ)) return null;
  return <ApprovalNotices meId={session.user.id} />;
}
