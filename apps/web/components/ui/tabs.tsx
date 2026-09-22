'use client';

import Link from 'next/link';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  key: string;
  label: ReactNode;
  /** Link tabs navigate (e.g. `?tab=mcp`); button tabs call onSelect. */
  href?: string;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Id prefix; each tab controls `${idBase}-panel` when a panel is rendered. */
  idBase?: string;
  /** Right-aligned extras after a spacer (design: "Duplicate agent"). */
  trailing?: ReactNode;
}

/**
 * Underlined tab strip (.tabs). Roving focus: Arrow keys / Home / End move
 * between tabs, Enter or Space activates.
 */
export function Tabs({ items, active, onSelect, label, idBase = 'tabs', trailing }: TabsProps) {
  const refs = useRef<Array<HTMLElement | null>>([]);

  function focusAt(index: number) {
    const count = items.length;
    refs.current[((index % count) + count) % count]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>, index: number) {
    if (event.key === 'ArrowRight') focusAt(index + 1);
    else if (event.key === 'ArrowLeft') focusAt(index - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(items.length - 1);
    else if (event.key === ' ' && items[index]?.href) event.currentTarget.click();
    else return;
    event.preventDefault();
  }

  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.key === active;
        const common = {
          id: `${idBase}-tab-${item.key}`,
          role: 'tab' as const,
          'aria-selected': selected,
          'aria-controls': `${idBase}-panel`,
          tabIndex: selected ? 0 : -1,
          className: selected ? 'on' : undefined,
          onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, index),
        };
        return item.href ? (
          <Link
            key={item.key}
            href={item.href}
            scroll={false}
            ref={(el) => {
              refs.current[index] = el;
            }}
            {...common}
          >
            {item.label}
          </Link>
        ) : (
          <button
            key={item.key}
            type="button"
            ref={(el) => {
              refs.current[index] = el;
            }}
            onClick={() => onSelect?.(item.key)}
            {...common}
          >
            {item.label}
          </button>
        );
      })}
      {trailing ? (
        <>
          <span className="sp" />
          {trailing}
        </>
      ) : null}
    </div>
  );
}

/** The panel a Tabs strip controls. */
export function TabPanel({ idBase = 'tabs', active, children }: { idBase?: string; active: string; children: ReactNode }) {
  return (
    <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${active}`} tabIndex={0}>
      {children}
    </div>
  );
}
