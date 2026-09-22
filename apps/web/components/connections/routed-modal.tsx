'use client';

import { useRouter } from 'next/navigation';
import { useCallback, type ReactNode } from 'react';
import { Modal, type ModalProps } from '@/components/ui/modal';

/** Closes a URL-driven dialog by navigating to `closeHref` (keeps the tab, drops the dialog params). */
export function useCloseTo(closeHref: string): () => void {
  const router = useRouter();
  return useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref]);
}

/** A Modal whose open state lives in the URL; server-rendered children are fine. */
export function RoutedModal({ closeHref, children, ...props }: Omit<ModalProps, 'onClose'> & { closeHref: string; children: ReactNode }) {
  const close = useCloseTo(closeHref);
  return (
    <Modal {...props} onClose={close}>
      {children}
    </Modal>
  );
}
