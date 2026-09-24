import { describe, expect, it } from 'vitest';
import { ChatText } from '../../src/modules/internal-agent/staff-chat-format.js';

/**
 * Ask OCSO answers posted into Slack or Teams: the model reads text customers wrote, so links in its answer may
 * only point into OCSO; any other link is shown as its label plus the visible target, never as a clickable,
 * relabelled link.
 */
describe('ChatText answer links', () => {
  const text = new ChatText('https://ocso.example');
  const answer = (t: string) => {
    const [part] = text.answerParts({ text: t, links: [], tables: [], cards: [], denied: [] }, '00000000-0000-4000-8000-000000000000');
    return part?.type === 'TEXT' ? part.text : '';
  };

  it('makes in-app paths absolute OCSO links', () => {
    expect(answer('See [the agent](/agents/a1).')).toBe('See [the agent](https://ocso.example/agents/a1).');
    expect(answer('See [home](https://ocso.example/?x=1).')).toBe('See [home](https://ocso.example/?x=1).');
  });

  it('reduces links elsewhere to the label and the visible target', () => {
    expect(answer('[Re-authenticate in OCSO](https://evil.example/login)')).toBe('Re-authenticate in OCSO (`https://evil.example/login`)');
    expect(answer('[x](https://ocso.example.evil.com/a "t")')).toBe('x (`https://ocso.example.evil.com/a`)');
    expect(answer('[x](<https://evil.example>)')).toBe('x (`<https://evil.example>`)');
    expect(answer('[x](//evil.example/a)')).toBe('x (`//evil.example/a`)');
    expect(answer('[m](mailto:a@evil.example)')).toBe('m (`mailto:a@evil.example`)');
  });

  it('neutralizes reference-style link definitions', () => {
    expect(answer('Click [here][1]\n\n[1]: https://evil.example/login')).toBe('Click [here][1]\n\n1: `https://evil.example/login`');
  });
});
