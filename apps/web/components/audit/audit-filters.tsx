import Form from 'next/form';
import Link from 'next/link';
import { AUDIT_VIA, TARGET_TYPES, type AuditParams } from './audit-meta';

const VIA_LABEL: Record<(typeof AUDIT_VIA)[number], string> = { UI: 'Web UI', API: 'API', INTERNAL_AGENT: 'Ask OCSO agent', SYSTEM: 'System' };

/** GET form over the audit filters (works without JavaScript; next/form navigates client-side when it can). */
export function AuditFilters({ params, actors }: { params: AuditParams; actors: Array<{ id: string; name: string }> }) {
  return (
    <Form action="/audit" className="au-filters" aria-label="Audit filters">
      <div className="fld">
        <label htmlFor="au-target">Target type</label>
        <select id="au-target" name="targetType" defaultValue={params.targetType ?? ''}>
          <option value="">Any target</option>
          {TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, ' ')}
            </option>
          ))}
          {params.targetType && !(TARGET_TYPES as readonly string[]).includes(params.targetType) ? <option value={params.targetType}>{params.targetType}</option> : null}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="au-action">Action starts with</label>
        <input id="au-action" name="action" defaultValue={params.action ?? ''} placeholder="e.g. alert_rule." />
      </div>
      <div className="fld">
        <label htmlFor="au-actor">Actor</label>
        {actors.length ? (
          <select id="au-actor" name="actorId" defaultValue={params.actorId ?? ''}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : (
          <input id="au-actor" name="actorId" defaultValue={params.actorId ?? ''} placeholder="actor id" />
        )}
      </div>
      <div className="fld">
        <label htmlFor="au-via">Via</label>
        <select id="au-via" name="via" defaultValue={params.via ?? ''}>
          <option value="">Any channel</option>
          {AUDIT_VIA.map((v) => (
            <option key={v} value={v}>
              {VIA_LABEL[v]}
            </option>
          ))}
        </select>
      </div>
      <div className="fld">
        <label htmlFor="au-from" title="whole UTC days">From (UTC)</label>
        <input id="au-from" type="date" name="from" defaultValue={params.from ?? ''} />
      </div>
      <div className="fld">
        <label htmlFor="au-to" title="whole UTC days">To (UTC)</label>
        <input id="au-to" type="date" name="to" defaultValue={params.to ?? ''} />
      </div>
      {params.targetId ? <input type="hidden" name="targetId" value={params.targetId} /> : null}
      <div className="actions">
        <button type="submit" className="btn accent">
          Apply
        </button>
        <Link className="btn ghost" href="/audit">
          Clear
        </Link>
      </div>
    </Form>
  );
}
