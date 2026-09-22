'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { parseCustomerForm } from '@/components/customers/forms';
import { updateCustomer } from '../api/customers';
import { describeApiError } from '../api/errors';
import { getSession } from '../session';
import { field, type FormState } from './form-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH /v1/customers/:id (customers.manage). Audited; bumps the customer's context version. */
export async function updateCustomerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = field(formData, 'id');
  const values = Object.fromEntries(['displayName', 'language', 'externalRef', 'attributes', 'accountOwnerUserId'].map((k) => [k, field(formData, k)]));
  if (!UUID.test(id)) return { status: 'error', message: 'Unknown customer.', values };
  const parsed = parseCustomerForm(values);
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.CUSTOMERS_MANAGE)) return { status: 'error', message: 'Your role cannot edit customers.', values };
  try {
    await updateCustomer(id, parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: 'Customer saved' };
}
