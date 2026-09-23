'use client';

import { useMemo, useState, useTransition } from 'react';
import { PERMISSION_GROUPS, isEmptyRightsChange, planRightsChange, type Permission, type PermissionGroup, type PermissionOp, type RightsState, type Role, type UserStatus } from '@ocso/auth';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { changePermissionsAction, type PermissionChangeForm, type PermissionChangeOutcome } from '@/lib/actions/permissions';

export interface PermissionChoice {
  permission: Permission;
  label: string;
  group: PermissionGroup;
}

export interface ChangePermissionsProps {
  user: { id: string; name: string; role: Role; status: UserStatus; teamIds: readonly string[] };
  /** Uncleared overrides (expiresAt ISO). */
  overrides: ReadonlyArray<{ permission: Permission; effect: 'GRANT' | 'REVOKE'; expiresAt: string | null }>;
  catalogue: readonly PermissionChoice[];
}

type Op = 'GRANT' | 'REVOKE' | 'CLEAR';
interface Row {
  key: number;
  op: Op;
  permission: Permission | '';
  expiresOn: string;
}

const OP_LABEL: Record<Op, string> = { GRANT: 'Grant', REVOKE: 'Revoke', CLEAR: 'Clear override' };
const today = () => new Date().toISOString().slice(0, 10);

function toOps(rows: readonly Row[]): PermissionOp[] {
  return rows.flatMap((r): PermissionOp[] => {
    if (!r.permission) return [];
    if (r.op === 'GRANT') return [{ op: 'GRANT', permission: r.permission, expiresAt: r.expiresOn ? new Date(`${r.expiresOn}T23:59:59.999Z`) : null }];
    return [{ op: r.op, permission: r.permission }];
  });
}

/**
 * "Change permissions" (PM/research/11 §3.6): grant, revoke or clear single
 * permissions with an optional expiry and a reason. The dialog plans the
 * change as the API will: reductions apply at once, even beside an increase;
 * what widens access needs a checker's approval (the API answers 409
 * approval_required until the approvals screen can name one).
 */
export function ChangePermissions({ user, overrides, catalogue }: ChangePermissionsProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([{ key: 0, op: 'GRANT', permission: '', expiresOn: '' }]);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<PermissionChangeOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const before: RightsState = useMemo(
    () => ({ role: user.role, status: user.status, teamIds: user.teamIds, overrides: overrides.map((o) => ({ ...o, expiresAt: o.expiresAt ? new Date(o.expiresAt) : null })) }),
    [user, overrides],
  );
  const ops = toOps(rows);
  // As the API will carry it out: reductions apply at once even when the same change also widens access.
  const plan = ops.length ? planRightsChange(before, { ops }) : null;
  const reduces = plan !== null && !isEmptyRightsChange(plan.direct) && plan.directClassification.direction !== 'NONE';
  const increase = plan?.proposed != null;
  const gained = plan?.proposedClassification?.gained.length ?? 0;
  const duplicate = new Set(ops.map((o) => o.permission)).size !== ops.length;
  const footer = !plan ? 'add a change' : increase ? (reduces ? 'mixed · reductions apply at once, the rest needs approval' : 'increase · needs approval') : reduces ? 'decrease · applies at once' : 'changes nothing';

  const close = () => {
    setOpen(false);
    reset();
  };
  const reset = () => {
    setRows([{ key: 0, op: 'GRANT', permission: '', expiresOn: '' }]);
    setReason('');
    setOutcome(null);
  };
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const submit = () =>
    start(async () => {
      const result = await changePermissionsAction({
        userId: user.id,
        preset: null,
        changes: rows.flatMap((r): PermissionChangeForm['changes'] => {
          if (!r.permission) return [];
          return r.op === 'GRANT' ? [{ op: 'GRANT', permission: r.permission, expiresOn: r.expiresOn || null }] : [{ op: r.op, permission: r.permission }];
        }),
        reason,
        checkerId: null,
      });
      setOutcome(result);
      if (result.kind === 'applied' || result.kind === 'proposed') {
        setNotice(result.message);
        close();
      }
    });

  return (
    <>
      <span className="tm-perm-actions">
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          Change permissions
        </button>
        {notice ? (
          <span className="mono-sm" role="status">
            {notice}
          </span>
        ) : null}
      </span>
      {open ? (
        <Modal
          title="Change permissions"
          sub={user.name}
          maxWidth={640}
          onClose={close}
          footer={
            <>
              <span className="mono-sm" aria-live="polite">
                {footer}
              </span>
              <span className="sp" />
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn accent" disabled={pending || !ops.length || duplicate || reason.trim().length < 3} onClick={submit}>
                {pending ? 'Saving…' : increase ? 'Request approval' : 'Apply now'}
              </button>
            </>
          }
        >
          <div style={{ display: 'grid', gap: 12 }}>
            {outcome && (outcome.kind === 'approval_required' || outcome.kind === 'error') ? (
              <AlertBanner tone={outcome.kind === 'error' ? 'error' : 'warn'} title={outcome.kind === 'approval_required' ? 'Approval required' : undefined} style={{ margin: 0 }}>
                {outcome.message}
              </AlertBanner>
            ) : null}
            <ul className="tm-ops" aria-label="Changes">
              {rows.map((row, index) => (
                <li key={row.key}>
                  <label className="sr-only" htmlFor={`pc-op-${row.key}`}>Action {index + 1}</label>
                  <select id={`pc-op-${row.key}`} value={row.op} onChange={(e) => update(row.key, { op: e.target.value as Op })}>
                    {(Object.keys(OP_LABEL) as Op[]).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABEL[op]}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor={`pc-perm-${row.key}`}>Permission {index + 1}</label>
                  <select id={`pc-perm-${row.key}`} value={row.permission} onChange={(e) => update(row.key, { permission: e.target.value as Permission })}>
                    <option value="">Choose a permission…</option>
                    {PERMISSION_GROUPS.map((group) => (
                      <optgroup key={group} label={group}>
                        {catalogue
                          .filter((c) => c.group === group)
                          .map((c) => (
                            <option key={c.permission} value={c.permission}>
                              {c.label}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                  {row.op === 'GRANT' ? (
                    <>
                      <label className="sr-only" htmlFor={`pc-exp-${row.key}`}>Expires on {index + 1}</label>
                      <input id={`pc-exp-${row.key}`} type="date" min={today()} value={row.expiresOn} onChange={(e) => update(row.key, { expiresOn: e.target.value })} title="Optional: the grant ends after this day" />
                    </>
                  ) : (
                    <span />
                  )}
                  <button type="button" className="icon-btn" aria-label={`Remove change ${index + 1}`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn tiny" style={{ justifySelf: 'start' }} onClick={() => setRows((rs) => [...rs, { key: Math.max(...rs.map((r) => r.key)) + 1, op: 'GRANT', permission: '', expiresOn: '' }])}>
              Add change
            </button>
            {duplicate ? <span className="mono-sm">Each permission may appear once.</span> : null}
            <div className="fld">
              <label htmlFor="pc-reason">Reason</label>
              <textarea id="pc-reason" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Why this person's access changes (audited)" />
            </div>
            {increase ? (
              <AlertBanner tone="info" style={{ margin: 0 }}>
                {reduces ? 'The reductions in this change apply as soon as you save. The rest ' : 'This change '}increases access, so a checker holding <b>Check access changes</b> must approve it before it applies
                {gained ? ` (adds ${gained} permission${gained === 1 ? '' : 's'})` : ''}.
              </AlertBanner>
            ) : reduces ? (
              <p className="mono-sm">Reducing access is never held for approval: it applies as soon as you save.</p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
