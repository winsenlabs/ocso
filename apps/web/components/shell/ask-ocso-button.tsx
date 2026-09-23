'use client';

import { usePathname } from 'next/navigation';
import { AgentPortrait } from '@/components/ui/brand-mark';
import { areaLabel } from '@/lib/nav-active';
import { ASK_OCSO_DRAWER_ID, useAskOcso } from './ask-ocso-context';

/** Ask OCSO trigger: the accent card in the sidebar, or the compact topbar button. */
export function AskOcsoButton({ variant }: { variant: 'sidebar' | 'topbar' }) {
  const { open, toggle } = useAskOcso();
  const pathname = usePathname();
  const common = {
    type: 'button' as const,
    onClick: toggle,
    'aria-expanded': open,
    'aria-controls': open ? ASK_OCSO_DRAWER_ID : undefined,
    'aria-haspopup': 'dialog' as const,
    'aria-keyshortcuts': 'Meta+J Control+J',
  };

  if (variant === 'topbar') {
    return (
      <button className="btn tiny accent" {...common}>
        Ask OCSO ⌘J
      </button>
    );
  }
  return (
    <button className={open ? 'sb-walle active' : 'sb-walle'} {...common}>
      <AgentPortrait />
      <span className="grow">
        <span className="sb-walle-name">Ask OCSO</span>
        <span className="sb-walle-sub">context: {areaLabel(pathname)}</span>
      </span>
      <span className="sb-walle-badge" aria-hidden="true">
        ⌘J
      </span>
    </button>
  );
}
