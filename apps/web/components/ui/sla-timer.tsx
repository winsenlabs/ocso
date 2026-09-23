export type SlaLevel = 'ok' | 'risk' | 'breach';

export interface SlaTimerProps {
  level: SlaLevel;
  /** Elapsed share of the SLA window, 0–1 (bar fill). */
  progress?: number | undefined;
  /** Visible text, e.g. "04:12 to SLA" or "breached 01:38". */
  label: string;
  /** Hide the bar (e.g. "held 06:20"). */
  bar?: boolean;
}

const LEVEL_WORD: Record<SlaLevel, string> = { ok: 'SLA on track', risk: 'SLA at risk', breach: 'SLA breached' };

/** SLA timer (.sla): mono, tabular; colour only when it matters. */
export function SlaTimer({ level, progress = 0, label, bar = true }: SlaTimerProps) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <span className={level === 'ok' ? 'sla' : `sla ${level}`} title={`${LEVEL_WORD[level]} · ${label}`}>
      {bar ? (
        <span className="sbar" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      <span className="sr-only">{LEVEL_WORD[level]}: </span>
      {label}
    </span>
  );
}
