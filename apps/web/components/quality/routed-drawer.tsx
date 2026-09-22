'use client';

import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import { Drawer, type DrawerProps } from '@/components/ui/drawer';

/** A right drawer whose open state lives in the URL (`?correction=…`, `?customer=…`); server-rendered children. */
export function RoutedDrawer({ closeHref, children, ...props }: Omit<DrawerProps, 'onClose'> & { closeHref: string; children: ReactNode }) {
  const router = useRouter();
  const close = useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref]);
  return (
    <Drawer {...props} onClose={close}>
      {children}
    </Drawer>
  );
}
