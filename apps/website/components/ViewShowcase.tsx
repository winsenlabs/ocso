'use client';

import { useState } from 'react';
import { views } from '@/content/shots';
import { ProductShot } from './ProductShot';

/** One product screen per team, switchable, like the Rho site's ViewShowcase. */
export function ViewShowcase() {
  const [i, setI] = useState(0);
  return (
    <div>
      <div role="tablist" aria-label="Views by team" className="no-scrollbar mx-auto mb-6 flex w-fit max-w-full flex-nowrap gap-0.5 overflow-x-auto rounded-full border border-fg/10 bg-fg/[0.03] p-1 sm:gap-1">
        {views.map((x, n) => (
          <button
            key={x.key}
            id={`view-tab-${x.key}`}
            role="tab"
            type="button"
            aria-selected={n === i}
            aria-controls={`view-panel-${x.key}`}
            onClick={() => setI(n)}
            className={`whitespace-nowrap rounded-full px-3 py-2 text-sm transition sm:px-4 ${n === i ? 'bg-fg text-bg' : 'text-fg/70 hover:text-fg'}`}
          >
            <span className="hidden sm:inline">For your </span>
            {x.label.toLowerCase()}
          </button>
        ))}
      </div>
      {/* Every panel is in the HTML (the hidden ones are not fetched: their images are lazy). */}
      {views.map((x, n) => (
        <div key={x.key} id={`view-panel-${x.key}`} role="tabpanel" aria-labelledby={`view-tab-${x.key}`} hidden={n !== i}>
          <p className="mx-auto mb-6 max-w-2xl text-center text-[15px] text-fg/65">{x.line}</p>
          <ProductShot shot={x.shot} />
        </div>
      ))}
      <p className="mt-4 text-center font-mono text-xs text-fg/45">Screens from OCSO running with demo data.</p>
    </div>
  );
}
