'use client';

import { useState, useTransition } from 'react';
import { PendingBadge } from '@/components/approvals/pending-badge';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { setAlertRuleEnabledAction } from '@/lib/actions/alert-rules';
import type { AlertKind, AlertRule } from '@/lib/api/alerts';

export const ruleObjectKind = (kind: AlertKind) => (kind === 'TECHNICAL' ? 'alert_rule_technical' : 'alert_rule');

/**
 * On/off for a rule (PM/research/11 §4): off applies at once (a stop, even while
 * a proposal waits); on is always a proposal — the checkbox stays off until a
 * checker approves it. A never-approved rule reads "draft".
 */
export function RuleEnabledToggle({ rule }: { rule: Pick<AlertRule, 'id' | 'name' | 'kind' | 'enabled' | 'approval'> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const approval = useApprovalRequest();
  const waiting = rule.approval.pending;
  const state = rule.enabled ? 'on' : rule.approval.approved ? 'off' : 'draft';
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <label className="toggle-row" title={error ?? approval.error ?? undefined}>
        <input
          type="checkbox"
          checked={rule.enabled}
          disabled={pending || approval.pending || (!rule.enabled && Boolean(waiting))}
          aria-label={`${rule.name} enabled`}
          onChange={(e) => {
            setError(null);
            if (e.target.checked) {
              approval.run(
                { objectKind: ruleObjectKind(rule.kind), objectId: rule.id, title: `Turn on alert rule "${rule.name}"` },
                (choice) => setAlertRuleEnabledAction(rule.id, true, choice),
                { always: true },
              );
              return;
            }
            start(async () => {
              const r = await setAlertRuleEnabledAction(rule.id, false);
              if (!r.ok) setError(r.message);
            });
          }}
        />
        <span className="mono-sm">{error || approval.error ? 'failed' : state}</span>
      </label>
      {waiting ? <PendingBadge state={{ approved: rule.approval.approved, pending: waiting, updateNeedsApproval: true, checkPermission: '' }} /> : null}
      {approval.modal}
    </span>
  );
}
