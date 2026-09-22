'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { CONVERSATION_TYPES, PRIORITY_KEYS, parseQueueForm, parseSlaForm } from '@/components/queues/forms';
import { describeApiError } from '../api/errors';
import { createQueue, saveSlaPolicy, updateQueue } from '../api/queues';
import { getSession } from '../session';
import { field, type FormState } from './form-state';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function guard(permission: Permission, what: string): Promise<string | null> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session.permissions.has(permission) ? null : `Your role cannot ${what}.`;
}

/** POST /v1/queues, or PATCH /v1/queues/:id when the form carries an id (queues.manage). */
export async function saveQueueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = field(formData, 'id');
  const teamIds = formData.getAll('teamIds').filter((v): v is string => typeof v === 'string');
  const fields = {
    name: field(formData, 'name'),
    description: field(formData, 'description'),
    mode: field(formData, 'mode'),
    autoAssignAfterSeconds: field(formData, 'autoAssignAfterSeconds'),
    acceptTimeoutSeconds: field(formData, 'acceptTimeoutSeconds'),
    requiredSkills: field(formData, 'requiredSkills'),
    languages: field(formData, 'languages'),
    slaPolicyId: field(formData, 'slaPolicyId'),
  };
  const values = { ...fields, preferAccountOwner: formData.get('preferAccountOwner') ? 'on' : '', teamIds: teamIds.join(',') };
  const parsed = parseQueueForm({ ...fields, preferAccountOwner: formData.get('preferAccountOwner') !== null, teamIds });
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };
  const denied = await guard(Permission.QUEUES_MANAGE, 'manage queues');
  if (denied) return { status: 'error', message: denied, values };
  try {
    if (id && UUID.test(id)) await updateQueue(id, parsed.data);
    else await createQueue(parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: id ? `Saved queue ${parsed.data.name}` : `Created queue ${parsed.data.name}` };
}

/** POST /v1/sla-policies, or PUT /v1/sla-policies/:id when the form carries an id (sla.manage). */
export async function saveSlaPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const id = field(formData, 'id');
  const values: Record<string, string> = { name: field(formData, 'name'), firstHumanResponse: field(formData, 'firstHumanResponse'), atRiskPercent: field(formData, 'atRiskPercent') };
  for (const p of PRIORITY_KEYS) values[`pickup${p}`] = field(formData, `pickup${p}`);
  for (const t of CONVERSATION_TYPES) values[`resolution${t}`] = field(formData, `resolution${t}`);
  const parsed = parseSlaForm({
    name: values['name'] ?? '',
    firstHumanResponse: values['firstHumanResponse'] ?? '',
    atRiskPercent: values['atRiskPercent'] ?? '',
    pickup: Object.fromEntries(PRIORITY_KEYS.map((p) => [p, values[`pickup${p}`] ?? ''])),
    resolution: Object.fromEntries(CONVERSATION_TYPES.map((t) => [t, values[`resolution${t}`] ?? ''])),
  });
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };
  const denied = await guard(Permission.SLA_MANAGE, 'manage SLA policies');
  if (denied) return { status: 'error', message: denied, values };
  try {
    await saveSlaPolicy(id && UUID.test(id) ? id : null, parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: id ? `Saved SLA policy ${parsed.data.name}` : `Created SLA policy ${parsed.data.name}` };
}
