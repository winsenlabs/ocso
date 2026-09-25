import type { ReactNode } from 'react';

export interface PromptComponentCardProps {
  /** Compile order, shown as "01". */
  index: number;
  name: string;
  /** Owner / lock caption, e.g. "cs lead · legal review" or "owned by platform · read only". */
  owner: string;
  tokens: number;
  edited?: boolean;
  /** Extra chip before the token count (e.g. "edited · unsaved"). */
  badge?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

/** Versioned prompt component (.pcomp) as compiled into the runtime prompt (docs/archive/specs/05). */
export function PromptComponentCard({ index, name, owner, tokens, edited, badge, action, children }: PromptComponentCardProps) {
  return (
    <section className={edited ? 'pcomp edited' : 'pcomp'} aria-label={`Prompt component ${name}`}>
      <div className="ph2">
        <span className="ix">{index.toString().padStart(2, '0')}</span>
        <span className="nm">{name}</span>
        <span className="lock">{owner}</span>
        <span className="sp" style={{ flex: 1 }} />
        {badge}
        <span className="mono-sm">{tokens.toLocaleString('en')} tokens</span>
        {action}
      </div>
      <div className="pb">{children}</div>
    </section>
  );
}
