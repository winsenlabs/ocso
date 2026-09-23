import type { Permission, Principal } from '@ocso/auth';
import type { ActorContext, AuditStore } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { z } from 'zod';

/** Risk classes for internal-agent actions (docs/12 §4). */
export type InternalRisk = 'READ' | 'LOW_WRITE' | 'HIGH_WRITE';

/** A link to an OCSO object, rendered as a card in the drawer (design/05 `ccard`). */
export interface ObjectLink {
  label: string;
  detail?: string | undefined;
  href: string;
  status?: 'ok' | 'warn' | 'danger' | undefined;
}

export interface ToolAnswer {
  /** JSON data returned to the model. Must not contain secrets. */
  data: unknown;
  links?: ObjectLink[] | undefined;
  /** Optional compact table for the drawer (design/05 `minitable`). */
  table?: { columns: string[]; rows: Array<Array<string | number>> } | undefined;
}

/**
 * Where the user is in the OCSO UI when asking (design/05 "context · …").
 * Only a hint for resolving "this conversation"; tools still authorize access.
 */
export interface PageContext {
  path: string;
  conversationId?: string | undefined;
  agentId?: string | undefined;
}

export interface ToolContext {
  db: Db;
  principal: Principal;
  actor: ActorContext;
  now: Date;
  /** The audit store (ADR-032) for tools that read the audit log; absent → the main database's local window. */
  auditStore?: AuditStore | null | undefined;
}

/**
 * An insight tool (`insight.<name>` in the capability catalog): a read that aggregates across application
 * services, run in-process with the asking user's principal. Gated by one permission; always READ — every
 * change goes through its API route and a confirmation card instead.
 */
export interface InternalTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission;
  risk: 'READ';
  run(ctx: ToolContext, args: I): Promise<ToolAnswer>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInternalTool = InternalTool<any>;
