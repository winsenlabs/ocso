'use client';

import { ControlState } from '@/components/ui/control-state';
import { controlAction } from '@/lib/actions/conversations';
import type { ConversationDetail } from '@/lib/api/conversations';
import { formatClock, formatDuration, formatTime } from '@/lib/format';
import type { ControlView, WorkspaceAction } from './lib/control';
import { pickupSla, resolutionLabel, resolutionSla, slaLabel } from './lib/sla';
import { useActionRunner } from './lib/use-action';

export type DialogKind = 'return' | 'resolve' | 'transfer';

export interface ControlBannerProps {
  detail: ConversationDetail;
  view: ControlView;
  now: number;
  timeZone: string;
  customerTurns: number;
  passedNotes: number;
  onDialog: (kind: DialogKind) => void;
}

const DIRECT: ReadonlySet<WorkspaceAction> = new Set(['claim', 'accept', 'decline', 'take-over', 'cancel-return', 'reopen']);
const DIALOG: Partial<Record<WorkspaceAction, DialogKind>> = { 'return-to-ai': 'return', resolve: 'resolve', transfer: 'transfer' };

/** Takeover banner (design/01 .ban/.takeover): state, why, and the actions this viewer may take. */
export function ControlBanner({ detail, view, now, timeZone, customerTurns, passedNotes, onDialog }: ControlBannerProps) {
  const { pending, error, run } = useActionRunner();
  const agent = detail.agent.name;
  const handoff = detail.openHandoff;
  const act = (a: WorkspaceAction) => {
    const dialog = DIALOG[a];
    if (dialog) return onDialog(dialog);
    if (DIRECT.has(a)) void run(() => controlAction(detail.id, a as Parameters<typeof controlAction>[1]));
  };
  const button = (a: WorkspaceAction, label: string, tone: 'accent' | 'plain' | 'ghost' = 'plain') =>
    view.actions.includes(a) ? (
      <button key={a} type="button" className={tone === 'plain' ? 'btn tiny' : `btn tiny ${tone}`} disabled={pending} onClick={() => act(a)}>
        {label}
      </button>
    ) : null;

  let body;
  const resolution = resolutionSla(detail.controlState, detail.openedAt, detail.resolutionDueAt, now);
  switch (detail.controlState) {
    case 'AI_ACTIVE':
      body = (
        <div className="takeover ret">
          <ControlState state="ai" />
          <span className="tt">{agent} is handling this conversation</span>
          <span className="ts">no human action needed · {customerTurns} customer turn{customerTurns === 1 ? '' : 's'}</span>
          <span className="sp" style={{ flex: 1 }} />
          {button('take-over', 'Take over')}
        </div>
      );
      break;
    case 'ESCALATION_REQUESTED':
    case 'WAITING_FOR_HUMAN': {
      const sla = pickupSla(detail.controlState, detail.waitingSince, detail.slaDueAt, now);
      const waited = detail.waitingSince ? formatDuration((now - Date.parse(detail.waitingSince)) / 1000) : null;
      const offer = handoff?.status === 'OFFERED' ? (view.offeredToMe ? 'offered to you' : `offered to ${detail.assignedUser?.name ?? 'an exec'}`) : null;
      const expires = view.offeredToMe && handoff?.offerExpiresAt ? Math.round((Date.parse(handoff.offerExpiresAt) - now) / 1000) : null;
      const facts = [
        offer ?? (handoff?.mode === 'AUTO_ASSIGN' ? 'auto-assign' : 'open pickup'),
        expires !== null ? (expires > 0 ? `expires in ${formatClock(expires)}` : 'offer expired') : null,
        waited ? `waiting ${waited}` : null,
        detail.queue?.name ?? null,
        sla ? `SLA ${slaLabel(sla)}` : null,
        resolution ? resolutionLabel(resolution) : null,
      ].filter(Boolean);
      body = (
        <div className="takeover wait">
          <ControlState state="wait" />
          <span className="tt">
            {detail.controlState === 'ESCALATION_REQUESTED' ? 'Escalation requested' : `${agent} asked for a human`}
            {handoff ? ` · ${handoff.reasonText}` : ''}
          </span>
          <span className="ts">{facts.join(' · ')}</span>
          <span className="sp" style={{ flex: 1 }} />
          {button('claim', 'Claim conversation', 'accent')}
          {button('accept', 'Accept', 'accent')}
          {button('decline', 'Decline', 'ghost')}
          {button('take-over', 'Take over')}
        </div>
      );
      break;
    }
    case 'HUMAN_ACTIVE':
      body = (
        <div className="takeover">
          <ControlState state="human" />
          <span className="tt">{view.holdsIt ? 'You are handling this conversation.' : `${detail.assignedUser?.name ?? 'A colleague'} is handling this conversation.`}</span>
          <span className="ts">
            {agent} is attached and will not reply to the customer until control returns.
            {resolution ? ` · ${resolutionLabel(resolution)}` : ''}
          </span>
          <span className="sp" style={{ flex: 1 }} />
          {button('return-to-ai', 'Return to AI')}
          {button('resolve', 'Resolve')}
        </div>
      );
      break;
    case 'AI_RESUMING':
      body = (
        <div className="takeover ret">
          <ControlState state="returning" />
          <span className="tt">{agent} resumes on the next customer message</span>
          <span className="ts">
            handover summary{passedNotes > 0 ? ` + ${passedNotes} internal note${passedNotes === 1 ? '' : 's'}` : ''} passed to the agent
            {detail.handover ? ` · “${truncate(detail.handover.text, 90)}”` : ''}
          </span>
          <span className="sp" style={{ flex: 1 }} />
          {button('cancel-return', 'Cancel return')}
          {button('take-over', 'Take over')}
        </div>
      );
      break;
    case 'RESOLVED': {
      const handled = detail.resolvedAt ? formatDuration((Date.parse(detail.resolvedAt) - Date.parse(detail.openedAt)) / 1000) : null;
      const facts = [detail.resolvedAt ? `resolved ${formatTime(detail.resolvedAt, timeZone)}` : null, handled ? `open ${handled}` : null].filter(Boolean);
      body = (
        <div className="takeover resolved">
          <ControlState state="resolved" />
          <span className="tt">
            {detail.resolvedBy ? `Resolved by ${detail.resolvedBy.name}` : 'Resolved'}
            {detail.disposition ? ` · ${detail.disposition}` : ''}
          </span>
          <span className="ts">{facts.join(' · ')}</span>
          <span className="sp" style={{ flex: 1 }} />
          {button('reopen', 'Reopen')}
        </div>
      );
      break;
    }
  }

  return (
    <div className="ban">
      {body}
      {error ? (
        <div className="alert error" role="alert" style={{ margin: 0 }}>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
