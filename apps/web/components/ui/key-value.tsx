import type { ReactNode } from 'react';

export interface KeyValueItem {
  k: string;
  v: ReactNode;
}

/** Key/value grid (.kv): mono uppercase keys, prose values. */
export function KeyValue({ items, template, fontSize }: { items: KeyValueItem[]; template?: string; fontSize?: number }) {
  const style = template || fontSize ? { ...(template ? { gridTemplateColumns: template } : {}), ...(fontSize ? { fontSize } : {}) } : undefined;
  return (
    <div className="kv" style={style}>
      {items.map((item) => (
        <KeyValuePair key={item.k} item={item} />
      ))}
    </div>
  );
}

function KeyValuePair({ item }: { item: KeyValueItem }) {
  return (
    <>
      <span className="k">{item.k}</span>
      <span>{item.v}</span>
    </>
  );
}
