import { Avatar } from '@/components/ui/avatar';
import { ControlState, controlStateKind } from '@/components/ui/control-state';
import type { ConversationDetail } from '@/lib/api/conversations';
import { formatTime, initials } from '@/lib/format';
import { controlLabel } from './lib/labels';
import { channelLabel } from './lib/channel';

export interface ConversationHeaderProps {
  detail: ConversationDetail;
  externalRef: string | null;
  meId: string;
  timeZone: string;
  onTransfer: (() => void) | null;
}

/** Conversation header (design/01 .chead): who, where, who is in control. */
export function ConversationHeader({ detail, externalRef, meId, timeZone, onTransfer }: ConversationHeaderProps) {
  const name = detail.customer.name ?? detail.customer.identities[0]?.value ?? 'Unknown customer';
  const identity = detail.customer.identities[0]?.value;
  const meta = [
    detail.customer.name ? identity : null,
    channelLabel(detail.channel?.kind, detail.channel?.name),
    detail.displayId,
    `opened ${formatTime(detail.openedAt, timeZone)}`,
  ].filter(Boolean);
  const label = controlLabel({ controlState: detail.controlState, assignedUser: detail.assignedUser, handoff: detail.openHandoff }, meId);
  return (
    <div className="chead">
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        <Avatar initials={detail.customer.name ? initials(detail.customer.name) : 'CU'} size="sm" />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 className="nm" style={{ margin: 0, fontSize: 13.5, fontWeight: 700 }}>
              {name}
            </h2>
            {detail.priority === 'P1' || detail.priority === 'P2' ? <span className="schip muted">{detail.priority}</span> : null}
            {externalRef ? <span className="mono-sm">{externalRef}</span> : null}
          </span>
          <span className="mono-sm" style={{ display: 'block' }}>
            {meta.join(' · ')}
          </span>
        </span>
      </div>
      <span className="sp" style={{ flex: 1 }} />
      <ControlState state={controlStateKind(detail.controlState)}>{label}</ControlState>
      {onTransfer ? (
        <button type="button" className="btn tiny ghost" onClick={onTransfer}>
          Transfer
        </button>
      ) : null}
    </div>
  );
}
