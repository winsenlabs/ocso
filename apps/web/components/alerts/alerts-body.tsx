import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { LiveRefresh } from '@/components/system/live-refresh';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { hasAnyPermission, hasPermission, requireSession } from '@/lib/session';
import { alertsHref, parseAlertsParams, type AlertTab } from './alerts-meta';
import { AlertsInbox } from './alerts-inbox';
import { DestinationsTab } from './destinations-tab';
import { RulesTab } from './rules-tab';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Alerts (docs/11 §6–7): the role-scoped inbox, rule management per kind
 * (technical for the Tech admin, business for the Lead) and, for the Tech
 * Admin, notification destinations. Tab, filters and the open drawer live in the URL.
 */
export async function AlertsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, raw] = await Promise.all([requireSession(), searchParams]);
  if (!hasAnyPermission(session, [Permission.ALERTS_TECHNICAL_READ, Permission.ALERTS_BUSINESS_READ])) return <NotPermitted role={session.roleLabel} />;
  const params = parseAlertsParams(raw);
  const canDestinations = hasPermission(session, Permission.NOTIFICATION_DESTINATIONS_MANAGE);
  const tabs: Array<{ key: AlertTab; label: string }> = [
    { key: 'inbox', label: 'Inbox' },
    { key: 'rules', label: 'Rules' },
    ...(canDestinations ? [{ key: 'destinations' as const, label: 'Destinations' }] : []),
  ];
  const tab = tabs.some((t) => t.key === params.tab) ? (params.tab ?? 'inbox') : 'inbox';

  return (
    <>
      <Tabs
        label="Alert views"
        idBase="alerts"
        active={tab}
        items={tabs.map((t) => ({ key: t.key, label: t.label, href: alertsHref({ tab: t.key }) }))}
        trailing={<LiveRefresh events={['alert.opened', 'alert.updated', 'alert.resolved', 'config.changed']} />}
      />
      <TabPanel idBase="alerts" active={tab}>
        <div style={{ paddingTop: 14 }}>
          {tab === 'inbox' ? <AlertsInbox session={session} params={params} /> : null}
          {tab === 'rules' ? <RulesTab session={session} params={params} /> : null}
          {tab === 'destinations' ? <DestinationsTab session={session} params={params} /> : null}
        </div>
      </TabPanel>
    </>
  );
}
