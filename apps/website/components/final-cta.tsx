import { Mark } from './brand';
import { Ctas } from './cta';

export function FinalCta() {
  return (
    <section className="final" aria-labelledby="final-title">
      <div className="wrap final-inner">
        <Mark size={56} className="final-mark" />
        <h2 id="final-title">Put your AI agents and your people on one governed path.</h2>
        <p>
          Walk through the Meridian Bank demo, a fictional bank with live agents, queues and approvals, or clone the
          repository and run it on your own machine.
        </p>
        <Ctas />
      </div>
    </section>
  );
}
