import { Permission } from '@ocso/auth';
import { getSession, hasPermission } from '@/lib/session';
import { ExceptionReportNotice } from './report-notice';

/** Mounted once in the app frame: exception report readers hear when a report is ready to sign. */
export async function ExceptionReportNoticeSlot() {
  const session = await getSession();
  if (!session || !hasPermission(session, Permission.EXCEPTIONS_READ)) return null;
  return <ExceptionReportNotice />;
}
