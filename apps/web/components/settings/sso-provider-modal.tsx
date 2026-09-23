'use client';

import { useActionState, useEffect, useState } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Modal } from '@/components/ui/modal';
import { createSsoProviderAction } from '@/lib/actions/auth-settings';
import { IDLE } from '@/lib/actions/form-state';

const FORM_ID = 'sso-provider-form';

/** Add an OIDC or SAML provider. Secrets are write-only: submitted once, never displayed. */
export function SsoProviderModal({ onClose }: { onClose: () => void }) {
  const [state, action, pending] = useActionState(createSsoProviderAction, IDLE);
  const [type, setType] = useState<'oidc' | 'saml'>('oidc');
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};
  useEffect(() => {
    if (state.status === 'success') onClose();
  }, [state, onClose]);
  return (
    <Modal
      title="Add SSO provider"
      sub="users are linked to invited accounts by email"
      onClose={onClose}
      maxWidth={600}
      footer={
        <>
          <span className="sp" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn accent" disabled={pending}>
            {pending ? 'Checking the provider…' : 'Add provider'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} action={action} noValidate style={{ display: 'grid', gap: 14 }}>
        {state.message && state.status === 'error' ? <AlertBanner tone="error" style={{ margin: 0 }}>{state.message}</AlertBanner> : null}
        <div className="fld">
          <label htmlFor="sso-type">Protocol</label>
          <select id="sso-type" name="type" value={type} onChange={(e) => setType(e.target.value === 'saml' ? 'saml' : 'oidc')}>
            <option value="oidc">OpenID Connect</option>
            <option value="saml">SAML 2.0</option>
          </select>
        </div>
        <div className="fld-row">
          <TextField idPrefix="sso" name="name" label="Display name" defaultValue={v['name']} error={errors['name']} required />
          <TextField idPrefix="sso" name="providerId" label="Provider id" defaultValue={v['providerId']} error={errors['providerId']} hint="used in the callback URL, e.g. okta" required />
        </div>
        <TextField idPrefix="sso" name="domains" label="Email domains" defaultValue={v['domains']} error={errors['domains']} hint="comma-separated; only these addresses may sign in with this provider" required />
        {type === 'oidc' ? (
          <>
            <TextField idPrefix="sso" name="issuer" label="Issuer URL" defaultValue={v['issuer']} error={errors['issuer']} hint="discovery at <issuer>/.well-known/openid-configuration" required />
            <div className="fld-row">
              <TextField idPrefix="sso" name="clientId" label="Client ID" defaultValue={v['clientId']} error={errors['clientId']} required />
              <TextField idPrefix="sso" name="clientSecret" label="Client secret" type="password" autoComplete="off" error={errors['clientSecret']} hint="write-only" required />
            </div>
          </>
        ) : (
          <>
            <TextField idPrefix="sso" name="entryPoint" label="IdP single sign-on URL" defaultValue={v['entryPoint']} error={errors['entryPoint']} required />
            <TextField idPrefix="sso" name="idpEntityId" label="IdP entity ID" defaultValue={v['idpEntityId']} error={errors['idpEntityId']} required />
            <div className="fld">
              <label htmlFor="sso-certificate">IdP signing certificate (PEM)</label>
              <textarea id="sso-certificate" name="certificate" rows={5} aria-invalid={errors['certificate'] ? true : undefined} style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }} />
              {errors['certificate'] ? <span className="err" role="alert">{errors['certificate']}</span> : null}
            </div>
          </>
        )}
        <label className="mono-sm" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" name="autoProvision" /> Create unknown users on first sign-in (as Service member). Off: only invited users.
        </label>
      </form>
    </Modal>
  );
}
