import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { LiveRefresh } from '@/components/system/live-refresh';
import { AlertBanner } from '@/components/ui/alert-banner';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { loadLiveExceptions } from '@/lib/api/exceptions';
import { formatDateTime } from '@/lib/format';
import { hasPermission, requireSession } from '@/lib/session';
import { ExceptionSections, ExceptionTotals } from './exception-sections';
import { parseView } from './exceptions-meta';
import { ReportsList } from './reports-list';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /exceptions (PM/research/11 §7): the live view (every check, computed now
 * over the last seven days) and the weekly reports to sign and export.
 * Readers without exceptions.sign see their teams' items and platform-wide ones.
 */
export async function ExceptionsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, raw] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.EXCEPTIONS_READ)) return <NotPermitted role={session.roleLabel} />;
  const view = parseView(raw);
  const tz = session.user.deployment.timezone;
  const params = { before: first(raw['before']), beforeId: first(raw['beforeId']) };
  return (
    <>
      <Tabs
        label="Exception views"
        idBase="exceptions"
        active={view}
        items={[
          { key: 'live', label: 'Live', href: '/exceptions' },
          { key: 'reports', label: 'Weekly reports', href: '/exceptions?view=reports' },
        ]}
        trailing={<LiveRefresh events={['exception_report.ready']} />}
      />
      <TabPanel idBase="exceptions" active={view}>
        <div style={{ paddingTop: 14 }}>
          {view === 'live' ? <LiveView timeZone={tz} /> : <ReportsList timeZone={tz} canSign={hasPermission(session, Permission.EXCEPTIONS_SIGN)} cursor={params} />}
        </div>
      </TabPanel>
    </>
  );
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function LiveView({ timeZone }: { timeZone: string }) {
  const { content, scoped } = await loadLiveExceptions();
  return (
    <>
      <div className="exc-head">
        <ExceptionTotals content={content} />
        <span className="mono-sm">
          Computed {formatDateTime(content.generatedAt, timeZone)} · events since {formatDateTime(content.period.start, timeZone)}
        </span>
      </div>
      {scoped ? (
        <AlertBanner tone="info" title="Your teams’ view">
          You see exceptions in your teams and platform-wide ones. Holders of the sign permission see the whole report.
        </AlertBanner>
      ) : null}
      <ExceptionSections content={content} timeZone={timeZone} />
    </>
  );
}
