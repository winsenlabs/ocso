import 'server-only';
import { CONTROL_STATES, type ControlState } from '@ocso/domain';
import { z } from 'zod';
import { api } from './client';

/**
 * Customers (docs/03 Customer / CustomerIdentity; apps/api customers.controller.ts,
 * packages/application customers/customers.ts). Identities are masked by the API
 * in lists and detail; everyone sees only customers they have a visible
 * conversation with (a lead: their teams' agents and queues, ADR-026).
 */

const State = z.enum(CONTROL_STATES as [ControlState, ...ControlState[]]);

const Base = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  externalRef: z.string().nullable(),
  language: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  accountOwnerUserId: z.string().nullable(),
  contextVersion: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CustomerListItemSchema = Base.extend({
  identities: z.array(z.object({ kind: z.string(), display: z.string().nullable() })),
});
export type CustomerListItem = z.infer<typeof CustomerListItemSchema>;

export const CustomerDetailSchema = Base.extend({
  identities: z.array(z.object({ kind: z.string(), display: z.string().nullable(), verified: z.boolean() })),
  conversations: z.array(z.object({ id: z.string(), controlState: State, openedAt: z.string(), lastPreview: z.string().nullable(), agentId: z.string() })),
});
export type CustomerDetail = z.infer<typeof CustomerDetailSchema>;

/** PATCH /v1/customers/:id (customers.manage). Attribute changes invalidate turn caches (docs/05 §5). */
export interface CustomerPatch {
  displayName?: string | null;
  language?: string | null;
  externalRef?: string | null;
  attributes?: Record<string, unknown>;
  accountOwnerUserId?: string | null;
}

export function searchCustomers(search: string | undefined, limit = 50): Promise<CustomerListItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set('search', search);
  return api.get(`/v1/customers?${params.toString()}`, z.array(CustomerListItemSchema));
}

export function loadCustomerDetail(id: string): Promise<CustomerDetail> {
  return api.get(`/v1/customers/${encodeURIComponent(id)}`, CustomerDetailSchema);
}

export function updateCustomer(id: string, patch: CustomerPatch): Promise<void> {
  return api.command('PATCH', `/v1/customers/${encodeURIComponent(id)}`, patch);
}
