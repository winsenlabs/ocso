import { ROLE_LABELS, permissionsForRole, type Role } from '@ocso/auth';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { Sidebar, type SidebarGroup, type SidebarItem } from '@/components/ui/sidebar';
import { buildNav } from '@/lib/nav';
import { PreviewSection } from './preview-section';

/** Sample badges from design/OCSONav.dc.html, to show every badge tone. Preview only. */
const SAMPLE_BADGES: Record<string, SidebarItem['badge']> = {
  'my-work:conversations': { text: '7' },
  'my-work:pickup': { text: '4 !', tone: 'warn' },
  'my-work:alerts': { text: '2', tone: 'muted' },
  'operations:conversations': { text: '312' },
  'quality:corrections': { text: '6 !', tone: 'warn' },
  'oversight:alerts': { text: '2 !', tone: 'danger' },
  'integrations:channels': { text: '7', tone: 'muted' },
};

const VARIANTS: Array<{ role: Role; active: string; name: string; scope: string; askSub: string }> = [
  { role: 'CS_EXEC', active: 'top:home', name: 'Nikhil Menon', scope: 'Cards & EMI · Tier 2', askSub: 'context: home' },
  { role: 'CS_LEAD', active: 'operations:agents', name: 'Anjali Rao', scope: 'Maya — Customer Support', askSub: 'context: virtual agents' },
  { role: 'PLATFORM_TECH_ADMIN', active: 'platform:system', name: 'Tejas Shetty', scope: 'All agents · 3 active', askSub: 'context: system control center' },
];

function groupsFor(role: Role, active: string): SidebarGroup[] {
  return buildNav(new Set(permissionsForRole(role))).map((g) => ({
    key: g.key,
    label: g.label,
    items: g.items.map((i) => ({
      ...i,
      active: `${g.key}:${i.key}` === active,
      badge: SAMPLE_BADGES[`${g.key}:${i.key}`],
      ...(g.key === 'platform' && i.key === 'system' ? { dot: 'ok' as const } : {}),
      ...(g.key === 'platform' && i.key === 'workers' ? { meta: '6/10' } : {}),
    })),
  }));
}

/** The three role navs, derived from the real permission matrix. */
export function SidebarPreview() {
  return (
    <PreviewSection title="Sidebar / OCSONav" note="nav groups come from buildNav(permissionsForRole(role)); badges are preview samples">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 240px)', gap: 18, overflowX: 'auto' }}>
        {VARIANTS.map((v) => (
          <div key={v.role} style={{ height: 820, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <Sidebar
              region="ap-south-1"
              scope={{ org: 'Meridian Bank', label: 'Prod', path: v.scope }}
              ask={
                <div className="sb-walle">
                  <AgentPortrait />
                  <div className="grow">
                    <div className="sb-walle-name">Ask OCSO</div>
                    <div className="sb-walle-sub">{v.askSub}</div>
                  </div>
                  <span className="sb-walle-badge">⌘J</span>
                </div>
              }
              groups={groupsFor(v.role, v.active)}
              user={{ initials: v.name.split(' ').map((p) => p[0]).join(''), name: v.name, roleLabel: ROLE_LABELS[v.role] }}
              footerAction={<ThemeToggle />}
            />
          </div>
        ))}
      </div>
    </PreviewSection>
  );
}
