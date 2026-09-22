'use client';

/** Event subscription patterns: exact types, `<area>.*` or `*` (GET /v1/webhooks/event-types). */
export function EventPicker({ eventTypes, value, onChange }: { eventTypes: string[]; value: string[]; onChange: (next: string[]) => void }) {
  const selected = new Set(value);
  const all = selected.has('*');
  const areas = [...new Set(eventTypes.map((t) => t.split('.')[0] ?? t))];
  const toggle = (pattern: string, on: boolean) => onChange(on ? [...value.filter((v) => v !== pattern), pattern] : value.filter((v) => v !== pattern));

  return (
    <fieldset className="conn-fieldset">
      <legend>Events</legend>
      <label className="toggle-row">
        <input type="checkbox" checked={all} onChange={(e) => onChange(e.target.checked ? ['*'] : [])} />
        All events (*)
      </label>
      {areas.map((area) => {
        const wildcard = `${area}.*`;
        const areaOn = all || selected.has(wildcard);
        return (
          <div key={area} className="event-area">
            <label className="toggle-row">
              <input type="checkbox" checked={areaOn} disabled={all} onChange={(e) => toggle(wildcard, e.target.checked)} />
              <span className="mono-sm">{wildcard}</span>
            </label>
            <div className="checks">
              {eventTypes
                .filter((t) => t.startsWith(`${area}.`))
                .map((t) => (
                  <label key={t}>
                    <input type="checkbox" checked={areaOn || selected.has(t)} disabled={areaOn} onChange={(e) => toggle(t, e.target.checked)} />
                    {t}
                  </label>
                ))}
            </div>
          </div>
        );
      })}
      <span className="hint">{value.length ? `${value.length} pattern${value.length === 1 ? '' : 's'} selected` : 'choose at least one'}</span>
    </fieldset>
  );
}
