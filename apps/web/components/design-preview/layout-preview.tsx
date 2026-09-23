import { AlertBanner } from '@/components/ui/alert-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHead } from '@/components/ui/page-head';
import { SecHead } from '@/components/ui/sec-head';
import { Topbar } from '@/components/ui/topbar';
import { PreviewSection } from './preview-section';
import { TabsDemo } from './tabs-demo';

/** Page chrome: top bar, headings, tabs, alerts and empty states. */
export function LayoutPreview() {
  return (
    <PreviewSection title="Page chrome and feedback">
      <Topbar searchLabel="Search customers, conversations, agents">
        <button type="button" className="topbar-btn">
          Last 7 days
        </button>
        <button type="button" className="topbar-btn">
          Alerts{' '}
          <span className="sb-badge" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>
            3
          </span>
        </button>
        <button type="button" className="btn tiny accent">
          Ask OCSO ⌘J
        </button>
      </Topbar>
      <PageHead
        title="System control center"
        sub="Meridian Bank · single-tenant deployment · build 2026.03.18-a"
        actions={
          <>
            <button type="button" className="btn">
              Run health check
            </button>
            <button type="button" className="btn accent">
              Deploy log
            </button>
          </>
        }
      />
      <SecHead
        title="Pickup queue"
        count="4 waiting · Cards & EMI · Tier 2"
        desc="oldest first"
        actions={
          <button type="button" className="btn tiny accent">
            Open workspace
          </button>
        }
      />
      <TabsDemo />
      <AlertBanner title="Every screen has a state switcher.">Informational alert body.</AlertBanner>
      <AlertBanner tone="warn" title="Scaling out — queue age crossed the threshold">
        Oldest queue item 18s against a 10s scale-out target.
      </AlertBanner>
      <AlertBanner
        tone="error"
        title="Time to first token above SLO on support-primary"
        action={
          <button type="button" className="btn tiny">
            Acknowledge
          </button>
        }
      >
        p95 TTFT 2.9s against a 1.2s objective for 11 minutes.
      </AlertBanner>
      <div className="row2">
        <EmptyState
          title="No pickup data yet"
          actions={
            <button type="button" className="btn tiny">
              Action
            </button>
          }
        >
          Conversations waiting for a human will be listed here once the conversations API is connected.
        </EmptyState>
        <EmptyState size="sm" title="Compact empty state">
          Used inside rail cards.
        </EmptyState>
      </div>
    </PreviewSection>
  );
}
