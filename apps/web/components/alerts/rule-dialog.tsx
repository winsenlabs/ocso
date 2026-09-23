'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { ApprovableButton } from '@/components/approvals/approvable-button';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { createAlertRuleAction, deleteAlertRuleAction, updateAlertRuleAction, type RuleFormInput } from '@/lib/actions/alert-rules';
import type { AlertCondition, AlertKind, AlertRule, AlertSeverity, AudienceRole } from '@/lib/api/alerts';
import { ROLE_LABEL } from './alerts-meta';
import { CheckList, ParamInputs } from './rule-fields';
import { ruleObjectKind } from './rule-enabled-toggle';
import { buildParams, initialParamText, paramFields } from './rule-params';

/** Roles that can read each kind (packages/auth): the API rejects an audience that could not see the alert. */
const AUDIENCE: Record<AlertKind, AudienceRole[]> = { TECHNICAL: ['TECH'], BUSINESS: ['HEAD', 'LEAD', 'SERVICE'] };
const DEFAULT_AUDIENCE: Record<AlertKind, AudienceRole[]> = { TECHNICAL: ['TECH'], BUSINESS: ['HEAD', 'LEAD'] };
const SEVERITIES: AlertSeverity[] = ['CRITICAL', 'WARNING', 'INFO'];

export interface DestinationOption {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

/**
 * Create or edit an alert rule (POST / PATCH /v1/alert-rules). Params follow the chosen condition's schema.
 * Maker–checker (PM/research/11 §4): a new rule is created off; changing an approved rule and deleting go to a checker.
 */
export function RuleDialog({
  rule,
  kinds,
  initialKind,
  conditions,
  destinations,
  closeHref,
}: {
  rule: AlertRule | null;
  kinds: AlertKind[];
  initialKind: AlertKind;
  conditions: AlertCondition[];
  destinations: DestinationOption[];
  closeHref: string;
}) {
  const router = useRouter();
  const close = () => router.replace(closeHref, { scroll: false });
  const [kind, setKind] = useState<AlertKind>(rule?.kind ?? initialKind);
  const available = conditions.filter((c) => c.kinds.includes(kind));
  const [condition, setCondition] = useState(rule?.condition ?? available[0]?.condition ?? '');
  const current = conditions.find((c) => c.condition === condition) ?? null;
  const fields = useMemo(() => paramFields(current?.params), [current]);
  const [paramText, setParamText] = useState<Record<string, string>>(() => initialParamText(fields, rule?.params ?? null));
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState(rule?.name ?? '');
  const [severity, setSeverity] = useState<AlertSeverity>(rule?.severity ?? 'WARNING');
  const [windowSeconds, setWindowSeconds] = useState(String(rule?.windowSeconds ?? 300));
  const [dedupe, setDedupe] = useState(String(rule?.dedupeWindowSeconds ?? 3600));
  const [audience, setAudience] = useState<string[]>(rule?.audienceRoles ?? DEFAULT_AUDIENCE[kind]);
  const [destinationIds, setDestinationIds] = useState<string[]>(rule?.destinationIds ?? []);
  const [autoResolve, setAutoResolve] = useState(rule?.autoResolve ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const approval = useApprovalRequest();
  const busy = pending || approval.pending;

  function chooseKind(next: AlertKind) {
    setKind(next);
    const first = conditions.find((c) => c.kinds.includes(next));
    chooseCondition(first?.condition ?? '');
    setAudience(DEFAULT_AUDIENCE[next]);
  }

  function chooseCondition(next: string) {
    setCondition(next);
    const c = conditions.find((x) => x.condition === next);
    setParamText(initialParamText(paramFields(c?.params), rule && rule.condition === next ? rule.params : null));
    setParamErrors({});
  }

  function save() {
    setError(null);
    const built = buildParams(fields, paramText);
    if (!built.ok) {
      setParamErrors(built.errors);
      return;
    }
    setParamErrors({});
    const input: RuleFormInput = {
      name,
      kind,
      condition,
      params: built.params,
      windowSeconds: Number(windowSeconds),
      severity,
      audienceRoles: audience.filter((r): r is AudienceRole => (AUDIENCE[kind] as string[]).includes(r)),
      destinationIds,
      dedupeWindowSeconds: Number(dedupe),
      autoResolve,
    };
    if (!Number.isInteger(input.windowSeconds) || !Number.isInteger(input.dedupeWindowSeconds)) {
      setError('Window and dedupe must be whole numbers of seconds.');
      return;
    }
    if (rule) {
      // A draft saves directly; an approved rule's change continues into the submit-for-approval modal.
      approval.run({ objectKind: ruleObjectKind(rule.kind), objectId: rule.id, title: `Change alert rule "${rule.name}"` }, (choice) => updateAlertRuleAction(rule.id, input, choice), {
        onApplied: close,
      });
      return;
    }
    start(async () => {
      const r = await createAlertRuleAction(input);
      if (r.ok) close();
      else setError(r.message);
    });
  }

  const title = rule ? `Edit rule · ${rule.name}` : `New ${kind === 'TECHNICAL' ? 'technical' : 'business'} rule`;
  return (
    <Modal
      title={title}
      sub={kind === 'TECHNICAL' ? 'technical · platform health' : 'business · agent outcomes'}
      onClose={close}
      maxWidth={760}
      footer={
        <>
          {rule ? (
            <ApprovableButton
              always
              label="Delete rule"
              buttonClass="btn danger"
              tone="danger"
              title={`Delete alert rule "${rule.name}"`}
              confirmLabel="Delete"
              disabled={Boolean(rule.approval.pending)}
              target={{ objectKind: ruleObjectKind(rule.kind), objectId: rule.id, title: `Delete alert rule "${rule.name}"` }}
              write={(choice) => deleteAlertRuleAction(rule.id, choice)}
            >
              Once a checker approves, its open alerts are resolved with the note “alert rule deleted”.
            </ApprovableButton>
          ) : null}
          <span className="sp" />
          <button type="button" className="btn" onClick={close}>
            {approval.outcome ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" form="rule-form" className="btn accent" disabled={busy || approval.outcome !== null || Boolean(rule?.approval.pending)}>
            {busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
          </button>
        </>
      }
    >
      <div aria-live="polite">
        {error || approval.error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {error ?? approval.error}
          </AlertBanner>
        ) : null}
        {approval.notice ? (
          <AlertBanner tone="info" style={{ margin: 0 }}>
            {approval.notice}
          </AlertBanner>
        ) : null}
        {rule?.approval.pending ? (
          <AlertBanner tone="warn" style={{ margin: 0 }}>
            A change to this rule is waiting for approval: edit or withdraw it from Approvals first.
          </AlertBanner>
        ) : null}
      </div>
      <form
        id="rule-form"
        noValidate
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="rule-name">Rule name</label>
            <input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
          </div>
          <div className="fld">
            <label htmlFor="rule-kind">Kind</label>
            <select id="rule-kind" value={kind} disabled={Boolean(rule) || kinds.length < 2} onChange={(e) => chooseKind(e.target.value as AlertKind)}>
              {(rule ? [rule.kind] : kinds).map((k) => (
                <option key={k} value={k}>
                  {k === 'TECHNICAL' ? 'Technical' : 'Business'}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="fld">
          <label htmlFor="rule-condition">Condition</label>
          <select id="rule-condition" value={condition} onChange={(e) => chooseCondition(e.target.value)}>
            {available.map((c) => (
              <option key={c.condition} value={c.condition}>
                {c.label}
              </option>
            ))}
          </select>
          {current ? <p className="rule-method">{current.method}</p> : null}
        </div>
        <ParamInputs fields={fields} values={paramText} errors={paramErrors} onChange={(k, v) => setParamText((p) => ({ ...p, [k]: v }))} />
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="rule-severity">Severity</label>
            <select id="rule-severity" value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s.toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="rule-window">Window (seconds)</label>
            <input id="rule-window" inputMode="numeric" value={windowSeconds} onChange={(e) => setWindowSeconds(e.target.value)} />
            <span className="hint">evaluated over this trailing window · 60 – 2,592,000</span>
          </div>
          <div className="fld">
            <label htmlFor="rule-dedupe">Re-open after (seconds)</label>
            <input id="rule-dedupe" inputMode="numeric" value={dedupe} onChange={(e) => setDedupe(e.target.value)} />
            <span className="hint">a resolved alert is not reopened within this time</span>
          </div>
        </div>
        <CheckList legend="Audience" options={AUDIENCE[kind].map((r) => ({ value: r, label: ROLE_LABEL[r] ?? r }))} value={audience} onChange={setAudience} />
        <CheckList
          legend="Deliver to"
          options={destinations.map((d) => ({ value: d.id, label: `${d.name}${d.enabled ? '' : ' (disabled)'}` }))}
          value={destinationIds}
          onChange={setDestinationIds}
          empty="no notification destination yet — alerts still appear in the inbox"
        />
        <label className="toggle-row">
          <input type="checkbox" checked={autoResolve} onChange={(e) => setAutoResolve(e.target.checked)} />
          Resolve automatically when the condition clears
        </label>
        <p className="mono-sm" style={{ margin: 0 }}>
          {!rule
            ? 'The rule is created off. Turn it on from the list: a checker approves it.'
            : rule.approval.approved
              ? 'Approved rule: saving sends the change to a checker; nothing changes until they approve.'
              : 'A draft: saved directly; it stays off until a checker approves turning it on.'}
        </p>
      </form>
      {approval.modal}
    </Modal>
  );
}
