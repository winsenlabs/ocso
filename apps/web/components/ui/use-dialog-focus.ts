'use client';

import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden]'));
}

/**
 * Dialog focus management: focuses the first field (or `[data-autofocus]`)
 * on open, closes on Escape, restores focus to the opener on close and —
 * when `trap` is set — keeps Tab inside the dialog. Escape also works when
 * focus has fallen back to <body> (e.g. the focused button became disabled).
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void, trap: boolean): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
    first.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (!root) return;
      const target = event.target instanceof Node ? event.target : null;
      const inside = target !== null && root.contains(target);
      if (event.key === 'Escape' && (inside || target === document.body)) {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!trap || !inside || event.key !== 'Tab') return;
      const items = focusables(root);
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, [ref, trap]);
}
