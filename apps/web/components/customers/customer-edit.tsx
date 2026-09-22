'use client';

import { useActionState, useEffect, useState } from 'react';
import { SelectField, TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { IDLE } from '@/lib/actions/form-state';
import { updateCustomerAction } from '@/lib/actions/customers';

export interface CustomerEditValues {
  id: string;
  displayName: string | null;
  language: string | null;
  externalRef: string | null;
  attributes: Record<string, unknown>;
  accountOwnerUserId: string | null;
}

/** Inline edit of a customer's context in the detail drawer → PATCH /v1/customers/:id (customers.manage). */
export function CustomerEdit({ customer, owners }: { customer: CustomerEditValues; owners: Array<{ value: string; label: string }> | null }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState(updateCustomerAction, IDLE);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const initial = (key: string, fallback: string) => (v && state.status === 'error' ? (v[key] ?? '') : fallback);

  useEffect(() => {
    if (state.status === 'success') setEditing(false);
  }, [state]);

  if (!editing) {
    return (
      <div className="rowsplit">
        <button type="button" className="btn tiny" onClick={() => setEditing(true)}>
          Edit customer
        </button>
        <span className="mono-sm" role="status" aria-live="polite">
          {state.status === 'success' ? state.message : 'changes are audited and refresh the agents’ customer context'}
        </span>
      </div>
    );
  }

  return (
    <form action={action} noValidate className="ops-edit" aria-label="Edit customer">
      {state.status === 'error' && state.message ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <input type="hidden" name="id" value={customer.id} />
      <TextField idPrefix="cu" name="displayName" label="Display name" defaultValue={initial('displayName', customer.displayName ?? '')} error={errors['displayName']} />
      <div className="fld-row">
        <TextField idPrefix="cu" name="language" label="Language" defaultValue={initial('language', customer.language ?? '')} error={errors['language']} hint="e.g. en, hi, mr" />
        <TextField idPrefix="cu" name="externalRef" label="External reference" defaultValue={initial('externalRef', customer.externalRef ?? '')} error={errors['externalRef']} hint="CRM id · unique" />
      </div>
      {owners ? (
        <SelectField idPrefix="cu" name="accountOwnerUserId" label="Account owner" options={[{ value: '', label: 'No account owner' }, ...owners]} defaultValue={initial('accountOwnerUserId', customer.accountOwnerUserId ?? '')} error={errors['accountOwnerUserId']} hint="preferred for routing when the queue allows" />
      ) : (
        <input type="hidden" name="accountOwnerUserId" value={customer.accountOwnerUserId ?? ''} />
      )}
      <div className="fld">
        <label htmlFor="cu-attributes">Attributes (JSON)</label>
        <textarea
          id="cu-attributes"
          name="attributes"
          rows={5}
          className="mono"
          defaultValue={initial('attributes', Object.keys(customer.attributes).length ? JSON.stringify(customer.attributes, null, 2) : '')}
          aria-invalid={errors['attributes'] ? true : undefined}
          aria-describedby={errors['attributes'] ? 'cu-attributes-error' : 'cu-attributes-hint'}
        />
        {errors['attributes'] ? (
          <span id="cu-attributes-error" className="err" role="alert">
            {errors['attributes']}
          </span>
        ) : (
          <span id="cu-attributes-hint" className="hint">
            material context for the agents · replaces the whole object
          </span>
        )}
      </div>
      <div className="rowsplit">
        <span className="sp" />
        <button type="button" className="btn tiny" onClick={() => setEditing(false)} disabled={pending}>
          Cancel
        </button>
        <button type="submit" className="btn tiny accent" disabled={pending}>
          {pending ? 'Saving…' : 'Save customer'}
        </button>
      </div>
    </form>
  );
}
