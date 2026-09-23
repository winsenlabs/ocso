import type { Role } from '@ocso/auth';
import type { PresenceState } from '@/components/ui/presence';
import type { StatusTone } from '@/components/ui/status-chip';

/** Shared display maps for the Team page (client-safe). */
export const ROLE_TONE: Record<Role, StatusTone> = { PLATFORM_TECH_ADMIN: 'accent', CS_LEAD: 'good', CS_EXEC: 'muted' };

export const AVAILABILITY: Record<'AVAILABLE' | 'AWAY' | 'OFFLINE', { state: PresenceState; label: string }> = {
  AVAILABLE: { state: 'working', label: 'available' },
  AWAY: { state: 'waiting', label: 'away' },
  OFFLINE: { state: 'off_shift', label: 'offline' },
};
