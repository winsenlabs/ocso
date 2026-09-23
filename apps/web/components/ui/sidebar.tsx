import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from './brand-mark';
import { Kbd } from './kbd';

export type SidebarBadgeTone = 'accent' | 'muted' | 'warn' | 'danger';

export interface SidebarItem {
  key: string;
  label: string;
  href: string;
  active?: boolean;
  kbd?: string | undefined;
  /** Count badge (sb-badge); omit when there is no real number to show. */
  badge?: { text: string; tone?: SidebarBadgeTone } | undefined;
  /** Mono caption on the right, e.g. "6/10". */
  meta?: string | undefined;
  /** Health dot on the right. */
  dot?: 'ok' | 'w' | 'd' | undefined;
}

export interface SidebarGroup {
  key: string;
  label?: string | undefined;
  items: SidebarItem[];
}

export interface SidebarProps {
  region?: string | null | undefined;
  /** Deployment scope: organization + deployment label, and what the user is scoped to. */
  scope: { org: string; label: string; path: string };
  /** The Ask OCSO trigger (interactive, supplied by the shell). */
  ask?: ReactNode;
  groups: SidebarGroup[];
  user: { initials: string; name: string; roleLabel: string };
  /** Footer control, e.g. the theme toggle. */
  footerAction?: ReactNode;
}

const BADGE_STYLE: Record<'warn' | 'danger', { background: string; color: string }> = {
  warn: { background: 'var(--warn-soft)', color: 'var(--warn)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
};

/** OCSONav: brand, deployment scope, Ask OCSO, role-specific groups, user footer. */
export function Sidebar({ region, scope, ask, groups, user, footerAction }: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="OCSO">
      <div className="sb-brand" style={{ justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="a-mark">
            <BrandMark />
          </div>
          <div className="a-word">OCSO</div>
        </div>
        {region ? <span className="region">{region}</span> : null}
      </div>

      <div className="scope-sw" title="Deployment · single tenant">
        <div className="sw-org">
          {scope.org.toUpperCase()} · {scope.label.toUpperCase()}
        </div>
        <div className="sw-path">
          <span className="sw-proj">{scope.path}</span>
          <svg
            style={{ width: 12, height: 12, marginLeft: 'auto', color: 'var(--ink-4)' }}
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 8l3-3 3 3M7 12l3 3 3-3" />
          </svg>
        </div>
      </div>

      {ask}

      <nav aria-label="Primary">
        {groups.map((group) => (
          <div
            className="sb-group"
            key={group.key}
            role={group.label ? 'group' : undefined}
            aria-label={group.label ?? undefined}
            data-nav-group={group.key}
          >
            {group.label ? (
              <div className="sb-group-label" aria-hidden="true">
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <SidebarLink item={item} key={item.key} />
            ))}
          </div>
        ))}
      </nav>

      <div className="sb-foot">
        <div className="sb-foot-avatar" aria-hidden="true">
          {user.initials}
        </div>
        <div className="grow">
          <div className="sb-foot-name">{user.name}</div>
          <div className="sb-foot-status" title={user.roleLabel}>
            <span className="role">{user.roleLabel}</span>
          </div>
        </div>
        {footerAction}
      </div>
    </aside>
  );
}

function SidebarLink({ item }: { item: SidebarItem }) {
  const tone = item.badge?.tone;
  return (
    <Link
      className={item.active ? 'sb-item active' : 'sb-item'}
      href={item.href}
      aria-current={item.active ? 'page' : undefined}
      data-nav-key={item.key}
    >
      <span className="sb-name">{item.label}</span>
      {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
      {item.badge ? (
        <span
          className={tone === 'muted' ? 'sb-badge muted' : 'sb-badge'}
          style={tone === 'warn' || tone === 'danger' ? BADGE_STYLE[tone] : undefined}
        >
          {item.badge.text}
        </span>
      ) : null}
      {item.meta ? <span className="mono-sm">{item.meta}</span> : null}
      {item.dot ? <span className={item.dot === 'ok' ? 'okdot' : `okdot ${item.dot}`} aria-hidden="true" /> : null}
    </Link>
  );
}
