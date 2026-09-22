import type { StatusTone } from '@/components/ui/status-chip';
import type { PresenceState } from '@/components/ui/presence';
import type { ToolRisk } from '@/components/ui/risk-badge';

/** Display labels and tones for agent-screen enums (client-safe, pure). */

export function agentPresence(status: string): { state: PresenceState; label: string } {
  if (status === 'LIVE') return { state: 'working', label: 'live' };
  if (status === 'PAUSED') return { state: 'paused', label: 'paused' };
  return { state: 'onboarding', label: 'draft' };
}

export const CONVERSATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  SUPPORT: 'Support',
  SALES: 'Sales',
  COLLECTIONS: 'Collections',
  ONBOARDING: 'Onboarding',
  CUSTOM: 'Custom',
};

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  CUSTOMER_REQUEST: 'Customer asks for a human',
  AGENT_DECISION: 'Agent decides to hand off',
  POLICY: 'Policy requires a human',
  INTENT: 'Intent detected',
  RISK: 'Risk signal',
  TOOL_FAILURE: 'Tool failures',
  SLA: 'SLA at risk',
  LOW_CONFIDENCE: 'Low confidence',
  BUSINESS_RULE: 'Business rule',
  SENSITIVE_ACTION: 'Sensitive action',
};

export const MODE_LABELS: Readonly<Record<string, string>> = { OPEN_PICKUP: 'open pickup', AUTO_ASSIGN: 'auto-assign' };

export const MID_TURN_LABELS: Readonly<Record<string, string>> = {
  QUEUE_BEHIND: 'Queue new messages behind the running turn',
  CANCEL_AND_RESTART: 'Cancel the running turn and restart with the new message',
};

export function priorityTone(priority: string): StatusTone {
  if (priority === 'P1') return 'danger';
  if (priority === 'P2') return 'warn';
  return 'muted';
}

export function toolRisk(riskClass: 'READ' | 'WRITE' | 'SENSITIVE'): ToolRisk {
  if (riskClass === 'READ') return 'read';
  if (riskClass === 'WRITE') return 'write';
  return '2-step';
}

export function correctionTone(status: string): StatusTone {
  if (status === 'STAGED') return 'accent';
  if (status === 'APPLIED') return 'good';
  if (status === 'REJECTED') return 'muted';
  return 'warn';
}

export function evaluationTone(status: string): StatusTone {
  if (status === 'COMPLETED') return 'good';
  if (status === 'FAILED') return 'danger';
  return 'accent';
}

export function alertTone(severity: string): 'info' | 'warn' | 'error' {
  if (severity === 'CRITICAL') return 'error';
  if (severity === 'WARNING') return 'warn';
  return 'info';
}

/** "tool_instructions" → "Tool instructions" when no descriptor label is at hand. */
export function componentLabel(key: string, labels?: ReadonlyMap<string, string>): string {
  const known = labels?.get(key);
  if (known) return known;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "REFUND_ABOVE_LIMIT" / "refund_above_limit" → "Refund above limit". */
export function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : code;
}

/** Short hash for dense rows: "pc_4f81a20c…" → "pc_4f81…a20c". */
export function shortHash(hash: string): string {
  const [prefix, rest] = hash.includes('_') ? [hash.slice(0, hash.indexOf('_') + 1), hash.slice(hash.indexOf('_') + 1)] : ['', hash];
  return rest.length <= 10 ? hash : `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

/** "12 Mar" / "04 Jan 2026" in the deployment timezone. */
export function formatDay(iso: string | null | undefined, timeZone: string, withYear = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', ...(withYear ? { year: 'numeric' } : {}) };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(d);
  }
}
