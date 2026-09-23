import type { ControlState } from '@ocso/domain';
import { CONTROL_STATE_LABELS, controlStateKind } from '../../ui/control-state';
import { firstName } from '../../../lib/format';

interface ControlLabelInput {
  controlState: ControlState;
  assignedUser: { id: string; name: string } | null;
  handoff: { status: string } | null;
}

/** Who is driving, as the inbox and header say it: "You · human", "Offered to you", "Waiting for human". */
export function controlLabel(item: ControlLabelInput, meId: string): string {
  const mine = item.assignedUser?.id === meId;
  if (item.controlState === 'HUMAN_ACTIVE') return mine ? 'You · human' : `${firstName(item.assignedUser?.name ?? 'Human')} · human`;
  if (item.controlState === 'WAITING_FOR_HUMAN' && item.handoff?.status === 'OFFERED') {
    return mine ? 'Offered to you' : `Offered to ${firstName(item.assignedUser?.name ?? 'an exec')}`;
  }
  return CONTROL_STATE_LABELS[controlStateKind(item.controlState)];
}

export function customerDisplayName(item: { customer: { name: string | null; identity: string | null } }): string {
  return item.customer.name ?? item.customer.identity ?? 'Unknown customer';
}
