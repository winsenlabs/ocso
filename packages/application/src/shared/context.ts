import type { Principal } from '@ocso/auth';
import type { Db, DbOrTx } from '@ocso/db';

/** Who is acting and how, carried through every use case for audit and events. */
export interface ActorContext {
  /** Authenticated human, when a person initiated the action. */
  principal: Principal | null;
  /** Non-human actors: the worker, a scheduler, a virtual agent. */
  system?: { kind: 'SYSTEM' | 'AGENT'; id: string; name?: string | undefined } | undefined;
  correlationId: string;
  ip?: string | undefined;
}

export const systemActor = (id: string, correlationId: string, name?: string): ActorContext => ({
  principal: null,
  system: { kind: 'SYSTEM', id, name },
  correlationId,
});

export const agentActor = (agentId: string, correlationId: string, name?: string): ActorContext => ({
  principal: null,
  system: { kind: 'AGENT', id: agentId, name },
  correlationId,
});

/** Dependencies every application service receives. */
export interface ServiceDeps {
  db: Db;
  now?: () => Date;
}

export type { Db, DbOrTx };

export function nowOf(deps: { now?: (() => Date) | undefined }): Date {
  return deps.now ? deps.now() : new Date();
}
