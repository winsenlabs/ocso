/**
 * Worker configuration form model (design/03 "Worker configuration", docs/archive/specs/10 §5).
 * Pure and client-safe. The API owns the bounds (WorkerSettingsInput): the form
 * only turns inputs into numbers and maps the API's "field: problem" messages
 * back onto the fields.
 */

export const WORKER_FORM_FIELDS = [
  { name: 'minWarmWorkers', label: 'Min warm workers', hint: 'floor kept running', unit: 'workers' },
  { name: 'maxWorkers', label: 'Max workers', hint: 'hard ceiling', unit: 'workers' },
  { name: 'conversationsPerWorker', label: 'Conversations per worker', hint: 'turn slots per worker, benchmarked', unit: 'slots' },
  { name: 'targetUtilization', label: 'Target utilization', hint: 'share of slots in use autoscaling aims for', unit: '%' },
  { name: 'scaleOutQueueAgeSeconds', label: 'Scale out at queue age', hint: 'oldest waiting turn', unit: 's' },
  { name: 'scaleOutQueueDepth', label: 'Scale out at queue depth', hint: 'waiting turns', unit: 'items' },
  { name: 'scaleInCooldownSeconds', label: 'Scale-in cooldown', hint: 'after the last scale-out', unit: 's' },
  { name: 'turnTimeoutSeconds', label: 'Turn timeout', hint: 'per agent execution', unit: 's' },
  { name: 'leaseDurationSeconds', label: 'Lease duration', hint: 'conversation ownership', unit: 's' },
  { name: 'heartbeatIntervalSeconds', label: 'Heartbeat interval', hint: 'worker liveness', unit: 's' },
  { name: 'idleLeaseSeconds', label: 'Idle lease release', hint: 'release a quiet conversation', unit: 's' },
] as const;

export type WorkerFormField = (typeof WORKER_FORM_FIELDS)[number]['name'];
export type WorkerValues = Record<WorkerFormField, number> & { autoscalingEnabled: boolean };
export type WorkerPatch = Partial<WorkerValues>;

const NAMES: ReadonlySet<string> = new Set(WORKER_FORM_FIELDS.map((f) => f.name));

/** Stored fraction → the percentage the form shows (float4 noise rounded away). */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

/** The form's string value for a field. */
export function displayValue(values: WorkerValues, name: WorkerFormField): string {
  return String(name === 'targetUtilization' ? toPercent(values[name]) : values[name]);
}

export type ParsedForm = { ok: true; values: WorkerValues } | { ok: false; fieldErrors: Record<string, string> };

/** Parse submitted strings into API values. Only "is it a number" is checked here. */
export function parseWorkerForm(raw: Record<string, string>, autoscalingEnabled: boolean): ParsedForm {
  const fieldErrors: Record<string, string> = {};
  const values: Partial<WorkerValues> = { autoscalingEnabled };
  for (const f of WORKER_FORM_FIELDS) {
    const text = (raw[f.name] ?? '').trim();
    const value = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) {
      fieldErrors[f.name] = 'Enter a number';
      continue;
    }
    values[f.name] = f.name === 'targetUtilization' ? Math.round(value * 10) / 1000 : value;
  }
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, values: values as WorkerValues };
}

/** Only the fields that differ from the current settings (keeps the audit entry precise). */
export function changedFields(current: WorkerValues, next: WorkerValues): WorkerPatch {
  const patch: WorkerPatch = {};
  for (const f of WORKER_FORM_FIELDS) if (Math.abs(current[f.name] - next[f.name]) > 1e-6) patch[f.name] = next[f.name];
  if (current.autoscalingEnabled !== next.autoscalingEnabled) patch.autoscalingEnabled = next.autoscalingEnabled;
  return patch;
}

/**
 * Split an API validation message ("maxWorkers: Too small…; minWarmWorkers: must
 * not exceed max workers") into per-field messages; the rest stays form-level.
 */
export function apiFieldErrors(message: string): { fieldErrors: Record<string, string>; rest: string[] } {
  const fieldErrors: Record<string, string> = {};
  const rest: string[] = [];
  for (const part of message.split(/;\s*/).map((p) => p.trim()).filter(Boolean)) {
    const match = /^([A-Za-z]+)(?:\.[\w.]+)?:\s*(.+)$/.exec(part);
    const field = match?.[1];
    if (match && field && NAMES.has(field)) fieldErrors[field] ??= match[2] ?? part;
    else rest.push(part);
  }
  return { fieldErrors, rest };
}
