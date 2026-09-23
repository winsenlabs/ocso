'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Drawer } from '@/components/ui/drawer';

/** URL-driven drawer for one audit entry; the server renders its content. */
export function AuditDrawer({ title, sub, closeHref, children }: { title: string; sub: string; closeHref: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <Drawer title={title} sub={sub} onClose={() => router.replace(closeHref, { scroll: false })}>
      {children}
    </Drawer>
  );
}
