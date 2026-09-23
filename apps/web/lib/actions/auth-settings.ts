'use server';

import { refresh } from 'next/cache';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { createSsoProvider, saveAuthPolicy, updateSsoProvider } from '../api/auth-settings';
import { ApiError, describeApiError } from '../api/errors';
import { approvalFromForm, outcomeMessage } from './form-approval';
import { field, fieldErrorsFrom, type FormState } from './form-state';

/** "Require MFA for roles" (Tech admin; the API enforces who may change it). */
export async function saveMfaPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const roles = formData.getAll('requireMfaRoles').filter((r): r is (typeof ROLES)[number] => typeof r === 'string' && (ROLES as readonly string[]).includes(r));
  const approval = approvalFromForm(formData);
  if (!approval.ok) return approval.state;
  let res: unknown;
  try {
    res = await saveAuthPolicy(roles, approval.approval);
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
  refresh();
  return outcomeMessage(res, roles.length ? 'MFA is now required for the selected roles at their next sign-in.' : 'MFA is no longer required for any role.');
}

const domains = z
  .string()
  .transform((v) => v.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,63}$/, 'Enter domains such as example.com')).min(1, 'Enter at least one email domain'));

const Common = {
  providerId: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Lowercase letters, digits and dashes (e.g. okta)'),
  name: z.string().trim().min(1, 'Enter a display name').max(80),
  domains,
  autoProvision: z.boolean(),
};
const OidcForm = z.object({ ...Common, issuer: z.url('Enter the issuer URL'), clientId: z.string().trim().min(1, 'Enter the client ID'), clientSecret: z.string().min(1, 'Enter the client secret') });
const SamlForm = z.object({
  ...Common,
  entryPoint: z.url('Enter the IdP single sign-on URL'),
  certificate: z.string().trim().min(40, 'Paste the IdP signing certificate (PEM)'),
  idpEntityId: z.string().trim().min(1, 'Enter the IdP entity ID').max(500),
});

/** Add an OIDC or SAML identity provider; the client secret goes to the API and is never shown again. */
export async function createSsoProviderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const type = field(formData, 'type') === 'saml' ? 'saml' : 'oidc';
  const values = { type, providerId: field(formData, 'providerId'), name: field(formData, 'name'), domains: field(formData, 'domains'), issuer: field(formData, 'issuer'), clientId: field(formData, 'clientId'), entryPoint: field(formData, 'entryPoint'), idpEntityId: field(formData, 'idpEntityId') };
  const base = { ...values, autoProvision: formData.get('autoProvision') === 'on' };
  try {
    if (type === 'oidc') {
      const parsed = OidcForm.safeParse({ ...base, clientSecret: field(formData, 'clientSecret') });
      if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
      const { issuer, clientId, clientSecret, ...common } = parsed.data;
      await createSsoProvider({ ...common, type: 'oidc', oidc: { issuer, clientId, clientSecret } });
    } else {
      const parsed = SamlForm.safeParse({ ...base, certificate: field(formData, 'certificate') });
      if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
      const { entryPoint, certificate, idpEntityId, ...common } = parsed.data;
      await createSsoProvider({ ...common, type: 'saml', saml: { entryPoint, certificate, idpEntityId } });
    }
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: `Added ${values.name} as a draft: sign-in through it starts once its activation is approved.` };
}

export type SsoActionResult = { ok: true; data: { message: string } } | { ok: false; message: string; code?: string | undefined };

const SsoApproval = z.union([z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);

/** A draft provider changes directly; an approved one needs `approval` (a proposal). */
export async function setAutoProvisionAction(providerId: string, autoProvision: boolean, approval?: z.input<typeof SsoApproval>): Promise<SsoActionResult> {
  const choice = approval === undefined ? undefined : SsoApproval.safeParse(approval);
  if (choice && !choice.success) return { ok: false, message: choice.error.issues.map((i) => i.message).join('; ') };
  let res: unknown;
  try {
    res = await updateSsoProvider(providerId, { autoProvision, ...(choice?.success ? { approval: choice.data } : {}) });
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
  refresh();
  if (res && typeof res === 'object' && 'proposal' in res) return { ok: true, data: { message: 'Sent for approval.' } };
  return { ok: true, data: { message: autoProvision ? 'Unknown users are now created as Service members.' : 'Only invited users can sign in with this provider.' } };
}

