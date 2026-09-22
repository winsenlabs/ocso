import { Permission as P } from '@ocso/auth';
import type { Session } from '@/lib/session';

export interface AskOcsoCopy {
  /** Mono line under the drawer title: what the agent may look at. */
  scopeLine: string;
  /** "role: cs lead" chip; the agent acts with exactly this user's permissions. */
  roleChip: string;
  suggestions: string[];
  userInitials: string;
}

/**
 * Role-aware drawer copy (design/05), derived from permissions. Suggestions
 * are generic questions each role may ask — never references to invented data.
 */
export function askOcsoCopy(session: Session, userInitials: string): AskOcsoCopy {
  const has = (p: (typeof P)[keyof typeof P]) => session.permissions.has(p);
  const roleChip = `role: ${session.roleLabel.toLowerCase()}`;
  if (has(P.SYSTEM_READ)) {
    return {
      scopeLine: `scope · platform · ${session.user.deployment.region ?? session.user.deployment.label.toLowerCase()}`,
      roleChip,
      suggestions: ['Which MCP connection is causing failures?', 'Show token spend by agent this week'],
      userInitials,
    };
  }
  if (has(P.CONVERSATIONS_READ_ALL)) {
    return {
      scopeLine: 'scope · virtual agents and business operations',
      roleChip,
      suggestions: ['Which agent is escalating most often?', 'What needs my attention right now?'],
      userInitials,
    };
  }
  return {
    scopeLine: 'scope · my conversations',
    roleChip,
    suggestions: ['What needs my attention right now?', 'Is there a similar case I can copy from?'],
    userInitials,
  };
}
