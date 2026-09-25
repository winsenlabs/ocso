import { repo } from '@/lib/site';
import { Icon } from './icons';
import { Section } from './section';
import { Shot } from './shot';

const POINTS = [
  {
    title: 'It acts as you, never as more',
    body: 'Every call goes through the real API route with a single-use delegation token for you. Guards, validation, team scope, approvals, rate limits and audit are exactly the UI’s.',
  },
  {
    title: 'Every write is a card you confirm',
    body: 'Reads answer straight away. A write comes back as a card built by the server, bound to the arguments and the object’s current state. It runs only when you click, once, within 15 minutes.',
  },
  {
    title: 'Governed changes go to a checker',
    body: 'A change that needs approval becomes a proposal with a checker and a reason. The checker can review and decide from Ask OCSO too. One governed switch turns writes off and leaves reads.',
  },
  {
    title: 'Also in Slack and Microsoft Teams',
    body: 'Link your chat account once and ask as yourself: same permissions, same confirmation cards, same approvals and audit as the drawer.',
  },
] as const;

const QUESTIONS = ['What needs my attention?', 'Which agent is escalating most often?', 'Which MCP connection is failing?'] as const;

export function AskOcso() {
  return (
    <Section
      id="ask-ocso"
      index="04"
      eyebrow="Ask OCSO"
      title="A copilot that can do anything you are permitted to do."
      intro={
        <>
          Press <kbd>⌘</kbd> <kbd>J</kbd> or <kbd>Ctrl</kbd> <kbd>J</kbd> anywhere in OCSO. New API routes become
          capabilities automatically, filtered to your permissions, so the copilot grows with the product.
        </>
      }
    >
      <div className="ask">
        <div className="ask-copy">
          <ul className="ask-questions" aria-label="Example questions">
            {QUESTIONS.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <ul className="point-list">
            {POINTS.map((p) => (
              <li key={p.title}>
                <Icon name="check" size={18} className="point-icon" />
                <div>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <p>
            <a className="text-link" href={repo('docs/operations/ask-ocso-in-chat.md')}>
              Ask OCSO in Slack and Teams
            </a>
          </p>
        </div>
        <Shot id="askOcso" className="shot-portrait" caption="A Head approves a colleague’s change from Ask OCSO: the card waits for her click." />
      </div>
    </Section>
  );
}
