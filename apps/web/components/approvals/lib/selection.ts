import type { ProposalListItem } from './schemas';

/**
 * Bulk approve selection (PM/research/11b): only open proposals I am the
 * named checker of, without a blocking warning, can be selected. Pure.
 */
export type SelectableRow = Pick<ProposalListItem, 'id' | 'status' | 'warnings' | 'checker'>;

/** Why a row cannot be bulk-approved, or null when it can. */
export function exclusionReason(row: SelectableRow, meId: string): string | null {
  if (row.status !== 'SUBMITTED') return 'Already decided';
  if (row.checker?.id !== meId) return 'You are not the named checker';
  const blocking = row.warnings.find((w) => w.blocksBulk);
  return blocking ? `${blocking.message} Open it to decide.` : null;
}

export const isSelectable = (row: SelectableRow, meId: string): boolean => exclusionReason(row, meId) === null;

/** Select all: every selectable row. */
export function selectAll(rows: readonly SelectableRow[], meId: string): string[] {
  return rows.filter((r) => isSelectable(r, meId)).map((r) => r.id);
}

/** Rows shown that the bulk bar leaves out (for "2 excluded"). */
export function excluded(rows: readonly SelectableRow[], meId: string): SelectableRow[] {
  return rows.filter((r) => r.status === 'SUBMITTED' && r.checker?.id === meId && !isSelectable(r, meId));
}

/** "Approve 3 selected · 2 excluded". */
export function bulkLabel(selected: number, excludedCount: number): string {
  const base = `Approve ${selected} selected`;
  return excludedCount ? `${base} · ${excludedCount} excluded` : base;
}
