import type { Role, UserStatus } from '@ocso/auth';
import type { PresenceState } from '@/components/ui/presence';
import type { StatusTone } from '@/components/ui/status-chip';

/** Shared display maps for the Team page (client-safe). */
export const ROLE_TONE: Record<Role, StatusTone> = { TECH: 'accent', HEAD: 'good', LEAD: 'good', SERVICE: 'muted' };

export const AVAILABILITY: Record<'AVAILABLE' | 'AWAY' | 'OFFLINE', { state: PresenceState; label: string }> = {
  AVAILABLE: { state: 'working', label: 'available' },
  AWAY: { state: 'waiting', label: 'away' },
  OFFLINE: { state: 'off_shift', label: 'offline' },
};

/** User status chips; a pending user waits for their creation to be approved (PM/research/11 §3.4). */
export const STATUS_CHIP: Record<UserStatus, { tone: StatusTone; label: string }> = {
  ACTIVE: { tone: 'good', label: 'active' },
  DISABLED: { tone: 'muted', label: 'disabled' },
  PENDING_APPROVAL: { tone: 'warn', label: 'pending approval' },
};
