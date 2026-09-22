import { Permission as P } from '@ocso/auth';
import type { Session } from '@/lib/session';

export interface AskOcsoCopy {
  /** Mono line under the drawer title: what the agent may look at. */
  scopeLine: string;
  /** "role: cs lead" chip; the agent acts with exactly this user's permissions. */
  roleChip: string;
  suggestions: string[];
  userInitials: string;
  /** Shown on confirmation cards: writes are attributed to this person. */
  userName: string;
  /** May choose the model profile Ask OCSO runs on (deployment settings). */
  canConfigure: boolean;
}

/**
 * Role-aware drawer copy (design/05), derived from permissions. Suggestions
 * are questions the role's internal-agent tools can answer from live data
 * (packages/internal-agent registry) — never references to invented objects.
 */
export function askOcsoCopy(session: Session, userInitials: string): AskOcsoCopy {
  const has = (p: (typeof P)[keyof typeof P]) => session.permissions.has(p);
  const common = {
    roleChip: `role: ${session.roleLabel.toLowerCase()}`,
    userInitials,
    userName: session.user.name,
    canConfigure: has(P.DEPLOYMENT_SETTINGS_MANAGE),
  };
  if (has(P.SYSTEM_READ)) {
    return {
      ...common,
      scopeLine: `scope · platform · ${session.user.deployment.region ?? session.user.deployment.label.toLowerCase()}`,
      suggestions: ['Which MCP connection is causing failures?', 'Why did latency spike in the last hour?'],
    };
  }
  if (has(P.CONVERSATIONS_READ_ALL)) {
    return {
      ...common,
      scopeLine: 'scope · virtual agents and business operations',
      suggestions: ['Which agent is escalating most often?', 'What needs my attention right now?'],
    };
  }
  return {
    ...common,
    scopeLine: 'scope · my conversations',
    suggestions: ['What needs my attention right now?', 'Which conversations are waiting for a human?'],
  };
}
