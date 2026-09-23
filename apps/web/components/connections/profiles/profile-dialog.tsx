'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { useApprovalRequest } from '@/components/approvals/use-approval-request';
import { saveProfileAction, testProviderAction, validateProfileAction } from '@/lib/actions/models';
import type { PolicyCheck, PriceCheck, Profile } from '@/lib/api/models';
import { DeleteByApproval } from '../lifecycle-actions';
import { initialProfileForm, toProfileInput, type ProfileFormState } from '../models/profile-form';
import { useCloseTo } from '../routed-modal';
import { FallbackEditor, providerOptionLabel, type ProviderOption } from './fallback-editor';
import { ModelCombobox } from './model-combobox';
import { PolicyPanel } from './policy-panel';
import { CacheFields, CapabilityFields, GenerationFields, Input } from './profile-fields';
import { needsPriceReview, SavedPrices } from './saved-prices';
import { ModelListsProvider } from './use-provider-models';

interface Props {
  providers: ProviderOption[];
  profile: Profile | null;
  /** Error categories that may move to the next target (from @ocso/domain). */
  fallbackCategories: string[];
  canTest: boolean;
  /** providers.manage: may refresh provider model lists past the API cache. */
  canRefreshModels: boolean;
  /** pricing.manage: may add a price for a model saved without one. */
  canPricing: boolean;
  closeHref: string;
}

const FORM_ID = 'profile-form';

/**
 * New / edit logical model profile (design/04 dialog). Every change is
 * re-validated against the deployment policy (POST /v1/model-profiles/validate);
 * Save stays disabled until the current form has passed that check.
 */
export function ProfileDialog(props: Props) {
  return (
    <ModelListsProvider>
      <ProfileDialogBody {...props} />
    </ModelListsProvider>
  );
}

function ProfileDialogBody({ providers, profile, fallbackCategories, canTest, canRefreshModels, canPricing, closeHref }: Props) {
  const close = useCloseTo(closeHref);
  const [state, setState] = useState<ProfileFormState>(() => initialProfileForm(profile, providers[0]?.id ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<{ key: string; result: PolicyCheck } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [savedPrices, setSavedPrices] = useState<PriceCheck[] | null>(null);
  const [validating, startValidate] = useTransition();
  const [saving, startSave] = useTransition();
  const approval = useApprovalRequest();
  const [testing, startTest] = useTransition();
  const latest = useRef('');

  const set = useCallback(<K extends keyof ProfileFormState>(key: K, value: ProfileFormState[K]) => setState((prev) => ({ ...prev, [key]: value })), []);
  const converted = useMemo(() => toProfileInput(state), [state]);
  const key = converted.ok ? JSON.stringify(converted.input) : '';
  const primary = providers.find((p) => p.id === state.providerId);

  useEffect(() => {
    if (!converted.ok) return;
    latest.current = key;
    const input = converted.input;
    const timer = setTimeout(() => {
      startValidate(async () => {
        const r = await validateProfileAction(input);
        if (latest.current !== key) return;
        if (r.ok) {
          setCheck({ key, result: r.data });
          setCheckError(null);
        } else setCheckError(r.message);
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [converted, key]);

  const current = check?.key === key ? check.result : null;
  const canSave = converted.ok && current?.ok === true && !saving;

  function save() {
    if (!converted.ok) {
      setErrors(converted.errors);
      return;
    }
    setErrors({});
    setMessage(null);
    const input = converted.input;
    const applied = (data: Awaited<ReturnType<typeof saveProfileAction>> & { ok: true }) => {
      if (data.data && needsPriceReview(data.data.prices)) setSavedPrices(data.data.prices);
      else close();
    };
    if (!profile) {
      startSave(async () => {
        const r = await saveProfileAction(null, input);
        if (!r.ok) setMessage(r.message);
        else applied(r);
      });
      return;
    }
    // A draft saves directly; an approved profile (or one a live agent uses) asks for a checker: a proposal.
    approval.run({ objectKind: 'model_profile', objectId: profile.id, title: `Change model profile ${profile.name}` }, (choice) => saveProfileAction(profile.id, input, choice), {
      onApplied: (data) => applied({ ok: true, data }),
    });
  }

  function testCall() {
    if (!primary || !state.model.trim()) return;
    setTestNote(null);
    startTest(async () => {
      const r = await testProviderAction(primary.id, state.model.trim());
      if (!r.ok) setTestNote(`Test call could not run: ${r.message}`);
      else if (r.data.call?.ok) setTestNote(`Test call passed · ${state.model.trim()} replied “${r.data.call.replyPreview ?? ''}”`);
      else setTestNote(`Test call failed · ${r.data.call?.error ? `${r.data.call.error.code}: ${r.data.call.error.message}` : (r.data.health.detail ?? r.data.status)}`);
    });
  }

  const shownErrors = converted.ok ? errors : { ...converted.errors, ...errors };
  const touchedErrors = (field: string) => (state.name || state.model ? shownErrors[field] : undefined);
  if (savedPrices) {
    return (
      <Modal
        title={`Saved ${state.name.trim()}`}
        sub="model prices"
        onClose={close}
        maxWidth={620}
        footer={
          <button type="button" className="btn accent" onClick={close}>
            Done
          </button>
        }
      >
        <SavedPrices prices={savedPrices} canPricing={canPricing} />
      </Modal>
    );
  }
  return (
    <Modal
      title={profile ? `Edit ${profile.name}` : 'New logical model profile'}
      sub="agents reference this name, not the model id"
      onClose={close}
      maxWidth={760}
      footer={
        <>
          <span className="mono-sm">
            {profile ? `assigned to ${profile.agents.length} agent${profile.agents.length === 1 ? '' : 's'}` : 'assigned to 0 agents'} · nothing changes until you save
          </span>
          <span className="sp" />
          {profile ? (
            <DeleteByApproval
              kind="model_profile"
              id={profile.id}
              name={profile.name}
              detail={
                profile.agents.length
                  ? `Agents ${profile.agents.map((a) => a.name).join(', ')} use this profile; the delete is refused until they are reassigned.`
                  : 'No agent uses this profile. Deleting it needs a second person’s approval.'
              }
            />
          ) : null}
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {canTest ? (
            <button type="button" className="btn" onClick={testCall} disabled={testing || !primary || !state.model.trim()}>
              {testing ? 'Calling…' : 'Test call'}
            </button>
          ) : null}
          <button type="submit" form={FORM_ID} className="btn accent" disabled={!canSave}>
            {saving ? 'Saving…' : profile ? 'Save profile' : 'Create profile'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {message || approval.error ? (
          <AlertBanner tone="error" style={{ margin: 0 }}>
            {message ?? approval.error}
          </AlertBanner>
        ) : null}
        {approval.notice ? (
          <AlertBanner tone="info" style={{ margin: 0 }}>
            {approval.notice}
          </AlertBanner>
        ) : null}
        {approval.modal}
        {testNote ? (
          <AlertBanner tone={testNote.startsWith('Test call passed') ? 'info' : 'warn'} style={{ margin: 0 }}>
            {testNote}
          </AlertBanner>
        ) : null}
        <div className="fld-row">
          <Input id="pf-name" label="Profile name" value={state.name} onChange={(v) => set('name', v)} error={touchedErrors('name')} hint="lowercase, stable — people and dashboards refer to it by name" />
          <Input id="pf-desc" label="Description (optional)" value={state.description} onChange={(v) => set('description', v)} />
        </div>
        <div className="fld-row">
          <div className="fld">
            <label htmlFor="pf-provider">Provider</label>
            <select id="pf-provider" value={state.providerId} onChange={(e) => set('providerId', e.target.value)}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {providerOptionLabel(p)}
                </option>
              ))}
            </select>
            <span className="hint">
              region {primary?.region ?? 'not set'} · data in {primary?.residencyZone ?? 'unspecified zone'}
            </span>
          </div>
          <ModelCombobox
            id="pf-model"
            label="Model"
            providerId={state.providerId}
            providerLabel={primary?.name ?? 'the provider'}
            value={state.model}
            onChange={(v) => set('model', v)}
            canRefresh={canRefreshModels}
            error={touchedErrors('model')}
          />
        </div>
        <FallbackEditor
          rows={state.fallbacks}
          providers={providers}
          onChange={(rows) => set('fallbacks', rows)}
          canRefreshModels={canRefreshModels}
          error={touchedErrors('fallbacks')}
        />
        <GenerationFields state={state} set={set} errors={shownErrors} />
        <CacheFields state={state} set={set} />
        <CapabilityFields state={state} set={set} />
        <PolicyPanel
          check={current ?? check?.result ?? null}
          stale={!current && check !== null}
          pending={validating}
          error={checkError}
          categories={fallbackCategories}
          cachePolicy={state.cachePolicy}
          cacheTtl={state.cacheTtl || null}
        />
      </form>
    </Modal>
  );
}
