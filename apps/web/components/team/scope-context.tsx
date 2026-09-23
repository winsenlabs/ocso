'use client';

import { createContext, use, type ReactNode } from 'react';
import type { TeamScope } from './lib/membership';

const TeamScopeContext = createContext<TeamScope | null>(null);

/** The Team page's people, teams, agents and queues, sent to the client once for every membership control. */
export function TeamScopeProvider({ scope, children }: { scope: TeamScope; children: ReactNode }) {
  return <TeamScopeContext value={scope}>{children}</TeamScopeContext>;
}

export function useTeamScope(): TeamScope {
  const scope = use(TeamScopeContext);
  if (!scope) throw new Error('useTeamScope needs a TeamScopeProvider');
  return scope;
}
