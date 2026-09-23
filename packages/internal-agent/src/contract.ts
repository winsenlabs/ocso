import type { Permission, Principal } from '@ocso/auth';
import type { ActorContext } from '@ocso/application';
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

/** One field a write would change, shown on the confirmation card (docs/12 §4). */
export interface ActionChange {
  label: string;
  before: string | null;
  after: string;
}

export interface ActionPreview {
  summary?: string | undefined;
  changes: ActionChange[];
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
}

/**
 * An internal tool is a thin adapter over an existing application service,
 * gated by exactly one permission and classified by risk. The model only
 * sees tools the current user may use; execution re-checks the permission.
 */
export interface InternalTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission;
  risk: InternalRisk;
  /** Human-readable description of a write for the confirmation card. */
  describe?: ((args: I) => string) | undefined;
  /**
   * Current → proposed values for the confirmation card, and optionally a
   * clearer one-line summary than `describe` (e.g. names instead of ids).
   * Read-only; never writes.
   */
  preview?: ((ctx: ToolContext, args: I) => Promise<ActionPreview>) | undefined;
  run(ctx: ToolContext, args: I): Promise<ToolAnswer>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInternalTool = InternalTool<any>;
