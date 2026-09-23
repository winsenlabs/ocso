import type { StatusTone } from '@/components/ui/status-chip';
import type { ApprovalStatus } from './schemas';

/** Display rules for proposals (pure). */
export const STATUS_CHIP: Record<ApprovalStatus | 'ACTIVATING', { tone: StatusTone; label: string }> = {
  SUBMITTED: { tone: 'warn', label: 'awaiting' },
  APPROVED: { tone: 'good', label: 'approved' },
  ACTIVATING: { tone: 'muted', label: 'activating' },
  REJECTED: { tone: 'danger', label: 'rejected' },
  WITHDRAWN: { tone: 'muted', label: 'withdrawn' },
  BLOCKED: { tone: 'danger', label: 'blocked' },
  VOID: { tone: 'muted', label: 'void' },
};

export function statusChip(p: { status: ApprovalStatus; activating: boolean; bootstrap?: boolean }): { tone: StatusTone; label: string } {
  if (p.activating) return STATUS_CHIP.ACTIVATING;
  const chip = STATUS_CHIP[p.status];
  return p.status === 'APPROVED' && p.bootstrap ? { ...chip, label: 'approved (bootstrap)' } : chip;
}

/** `modelProfile` → "model profile", `businessHours.timezone` → "business hours › timezone". */
export function fieldLabel(path: string): string {
  return path
    .split('.')
    .map((part) =>
      part
        .replace(/Id$/, '')
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase(),
    )
    .join(' › ');
}

/** A diff value as short text. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.length ? value.join(', ') : '(none)';
  return JSON.stringify(value);
}

/** "3 h", "2 d", "12 min". */
export function ageLabel(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
}

export const ACTION_LABEL: Record<string, string> = { CREATE: 'create', UPDATE: 'change', DELETE: 'delete', ACTIVATE: 'activate' };
