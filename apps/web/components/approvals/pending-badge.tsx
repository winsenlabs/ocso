import Link from 'next/link';
import { StatusChip } from '@/components/ui/status-chip';
import type { ObjectApprovalState } from './lib/schemas';

/**
 * "Pending approval · awaiting Anjali Rao" / "Approved — activating" on an
 * object's detail page; links to the proposal. Nothing when nothing is pending.
 */
export function PendingBadge({ state }: { state: ObjectApprovalState | null | undefined }) {
  const pending = state?.pending;
  if (!pending) return null;
  const label = pending.activating ? 'Approved — activating' : `Pending approval · awaiting ${pending.checkerName ?? 'a checker'}`;
  return (
    <Link className="ap-badge" href={`/approvals?box=sent&approval=${encodeURIComponent(pending.id)}`} aria-label={`${label} (open the proposal)`}>
      <StatusChip tone={pending.activating ? 'muted' : 'warn'}>{label}</StatusChip>
    </Link>
  );
}
