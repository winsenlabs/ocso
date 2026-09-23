'use client';

import { useOcsoChatState } from '../core/hooks.js';
import { cx, defaultLabels, type OcsoChatClassNames } from './shared.js';

export interface TypingIndicatorProps {
  classNames?: OcsoChatClassNames;
  label?: (name: string | undefined) => string;
}

/** "Maya is typing…" while a reply is being written. The live region stays mounted so screen readers announce it. */
export function TypingIndicator({ classNames, label = defaultLabels.typing }: TypingIndicatorProps) {
  const typing = useOcsoChatState((s) => s.typing, (a, b) => a?.who === b?.who && a?.name === b?.name);
  return (
    <div role="status" aria-live="polite" className={cx('ocso-chat__typing', classNames?.typing)} data-active={typing ? 'true' : 'false'}>
      {typing ? (
        <>
          <span className="ocso-chat__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>{label(typing.name)}</span>
        </>
      ) : null}
    </div>
  );
}
