import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import type { AlertRow } from '@/lib/api/alerts';

/** Compact alert stack for rail cards ("For you", "Needs a decision"). */
export function AlertList({ alerts, emptyText, limit = 3 }: { alerts: AlertRow[] | null; emptyText: string; limit?: number }) {
  if (alerts === null) {
    return (
      <EmptyState size="sm" title="No alert feed yet">
        {emptyText}
      </EmptyState>
    );
  }
  if (alerts.length === 0) return <span className="mono-sm">nothing open</span>;
  const shown = alerts.slice(0, limit);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {shown.map((a) => (
        <AlertBanner key={a.id} tone={a.severity === 'info' ? 'info' : 'warn'} title={a.title} style={{ margin: 0 }}>
          {a.detail}
        </AlertBanner>
      ))}
    </div>
  );
}
