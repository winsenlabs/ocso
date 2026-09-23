'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Sidebar, type SidebarGroup } from '@/components/ui/sidebar';
import type { NavGroup } from '@/lib/nav';
import { activeNavKey } from '@/lib/nav-active';
import { AskOcsoButton } from './ask-ocso-button';

export interface AppSidebarProps {
  nav: NavGroup[];
  region: string | null;
  scope: { org: string; label: string; path: string };
  user: { initials: string; name: string; roleLabel: string };
  footerAction: ReactNode;
}

/** Binds the presentational Sidebar to the router: active item from the current URL. */
export function AppSidebar({ nav, region, scope, user, footerAction }: AppSidebarProps) {
  const pathname = usePathname();
  const tab = useSearchParams().get('tab');
  const active = activeNavKey(nav, pathname, tab);
  const groups: SidebarGroup[] = nav.map((group) => ({
    key: group.key,
    label: group.label,
    items: group.items.map((item) => ({ ...item, active: `${group.key}:${item.key}` === active })),
  }));

  return (
    <Sidebar
      region={region}
      scope={scope}
      ask={<AskOcsoButton variant="sidebar" />}
      groups={groups}
      user={user}
      footerAction={footerAction}
    />
  );
}
