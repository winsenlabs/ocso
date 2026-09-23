import { Permission } from '@ocso/auth';
import { alertCounts } from '@/lib/api/alerts';
import { getSession, hasAnyPermission } from '@/lib/session';

/**
 * Unresolved-alert count for the top bar's Alerts button (design/03, design/06),
 * scoped by the API to the user's audience. Renders nothing when there is
 * nothing unresolved, the role reads no alerts, or the count is unavailable.
 */
export async function AlertsBadge() {
  const session = await getSession();
  if (!session || !hasAnyPermission(session, [Permission.ALERTS_TECHNICAL_READ, Permission.ALERTS_BUSINESS_READ])) return null;
  const counts = await alertCounts().catch(() => null);
  if (!counts || counts.unresolved === 0) return null;
  const critical = (counts.bySeverity['CRITICAL'] ?? 0) > 0;
  return (
    <span
      className="sb-badge"
      aria-label={`${counts.unresolved} unresolved`}
      style={critical ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : { background: 'var(--warn-soft)', color: 'var(--warn)' }}
    >
      {counts.unresolved}
    </span>
  );
}
