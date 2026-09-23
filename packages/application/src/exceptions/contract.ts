import type { DbOrTx } from '@ocso/db';
import type { ApprovalRegistry } from '../approvals/registry.js';

/**
 * The exception report (PM/research/11 §7, ADR-033). Each kind is one check of
 * the controls; `compute` returns what went around or wrong in the period.
 * Kinds read state through the application's own contracts (the approval
 * registry's descriptors, audit incidents), never by listing object kinds.
 */

export type ExceptionSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Stands in for the owning teams of an item whose teams could not be read: it
 * matches no team, so only readers who see the whole report (signers) see it —
 * never widened to platform-wide.
 */
export const RESTRICTED_TEAM = 'restricted';

export interface ExceptionItem {
  /** What the item is about: an approval kind ('agent'), 'approval', 'user', 'queue', 'channel', 'audit_store', … */
  objectKind: string;
  /** Null for an item that summarises many objects (e.g. a failure count per channel). */
  objectId: string | null;
  title: string;
  detail: string;
  /** ISO time: when it happened, or the latest occurrence for a grouped item. */
  occurredAt: string;
  /** In-app link, or null. */
  href: string | null;
  /** Owning teams; [] = platform-wide (visible to every exceptions.read holder). */
  teamIds: string[];
  /**
   * A permission that lets a reader see this item deployment-wide whatever its teams (users.read for an item
   * about a person's access): the role that owns the object sees it even outside its teams. Null: teams only.
   */
  readableWith: string | null;
  /** Users who did it (maker, granter, the person who approved themselves): a signer among them is self-attesting. */
  actorIds: string[];
  /** Users it is about (whose access changed): likewise. */
  subjectIds: string[];
  /** Occurrences this item stands for (grouped items); 1 otherwise. */
  count: number;
}

/** Where a check's evidence lives, and so how far back it is complete (retention prunes it). */
export type ExceptionDataSource = 'audit' | 'conversation' | 'operational';

export interface ExceptionContext {
  db: DbOrTx;
  /** Every approvable kind (the one composition point, approvals/composition.ts). */
  registry: ApprovalRegistry;
  /** [start, end): events in the period; state (what is live, open, lagging) as of `now`. */
  period: { start: Date; end: Date };
  now: Date;
  /** LIVE: the screen's rolling view. REPORT: a frozen weekly/ad-hoc report. */
  mode: 'LIVE' | 'REPORT';
  /** deployment_settings.approval_age_warning_hours. */
  approvalAgeWarningHours: number;
}

export interface ExceptionKind {
  readonly id: string;
  readonly label: string;
  readonly severity: ExceptionSeverity;
  /** One sentence: what the check looks at (shown on screen and in the export). */
  readonly description: string;
  /** Event history the check reads; a period older than that data's retention is marked incomplete. */
  readonly sources?: readonly ExceptionDataSource[] | undefined;
  compute(ctx: ExceptionContext): Promise<ExceptionItem[]>;
}

/** How many items one audience sees: exact scoped totals even when the listed items are capped. */
export interface ExceptionScopeCount {
  teamIds: string[];
  readableWith: string | null;
  n: number;
}

/** One kind's section of a report. `error` when the check itself failed: recorded, never silently skipped. */
export interface ExceptionSection {
  id: string;
  label: string;
  severity: ExceptionSeverity;
  description: string;
  /** Items listed (at most the mode's cap). */
  items: ExceptionItem[];
  /** Total items before the cap. */
  total: number;
  truncated: boolean;
  /** Item counts per distinct (teams, readableWith) audience, over every item (not only those listed). */
  scopes: ExceptionScopeCount[];
  /** The earliest instant the check's evidence is complete from; `complete` false when the period starts before it. */
  coverage: { dataFrom: string; complete: boolean } | null;
  /** A short error class (e.g. 'db_error:57014', 'timeout'), never a raw driver message. */
  error: string | null;
}

export interface ExceptionReportContent {
  format: 'ocso-exception-report/2';
  /** Signed with the content: a live view, or which report this is. */
  kind: 'LIVE' | 'WEEKLY' | 'ADHOC';
  period: { start: string; end: string; timezone: string };
  generatedAt: string;
  sections: ExceptionSection[];
  totals: { items: number; bySeverity: Record<ExceptionSeverity, number>; failedChecks: number; truncatedChecks: number; incompleteChecks: number };
}

/** Per-kind caps. The live view stays light; a frozen report keeps far more as evidence (`total` is always exact). */
export const MAX_ITEMS_PER_KIND = 500;
export const MAX_ITEMS_PER_KIND_REPORT = 5_000;
