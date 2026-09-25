import { Fragment } from 'react';
import { Ctas } from './cta';
import { Shot } from './shot';

const WORDS = ['One', 'Customer', 'Success', 'Orchestrator'] as const;

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap">
        <p className="hero-tags">
          <span>Open source</span>
          <span>Apache-2.0</span>
          <span>Self-hosted</span>
        </p>
        <h1 id="hero-title" className="hero-title">
          {WORDS.map((word, i) => (
            <Fragment key={word}>
              <span className="initial">{word[0]}</span>
              {word.slice(1)}
              {i < WORDS.length - 1 ? ' ' : ''}
            </Fragment>
          ))}
        </h1>
        <p className="hero-value">AI agents and your people on every customer channel, governed the way a bank needs.</p>
        <p className="hero-body">
          OCSO is a runtime you host yourself. Named AI agents answer customers on WhatsApp, web chat, Slack and Microsoft
          Teams. Your team takes over any conversation and hands it back. Every change to live configuration waits for a
          second person&rsquo;s approval, and every action lands in a signed audit trail.
        </p>
        <Ctas />
      </div>
      <div className="wrap hero-shot">
        <Shot id="home" priority caption="Home for a Head in the Meridian Bank demo, a fictional bank." />
      </div>
    </section>
  );
}
