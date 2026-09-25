/* eslint-disable @next/next/no-img-element -- small SVG marks. */
import { REPO_URL, siteUrl } from '@/content/links';
import { ThemedMark } from './Mark';

/** The question we hand each assistant: specific, and pointed at our llms.txt so the answer is grounded. */
const PROMPT = `I'm looking into OCSO, Open Customer Success Orchestration (${siteUrl}), an open-source, self-hosted platform from Winsen Labs where AI agents and human teams serve customers across channels.

Please read ${siteUrl}/llms.txt and the repository at ${REPO_URL}, and explain in plain language:
1. What OCSO does and how a conversation moves from a channel to an AI agent or a person
2. How it governs changes and keeps an audit trail
3. What it takes to self-host it and extend it
4. How a customer success team like mine could get started

Cite the pages you use.`;

const q = encodeURIComponent(PROMPT);

const ASSISTANTS = [
  { name: 'ChatGPT', href: `https://chatgpt.com/?hints=search&q=${q}`, icon: '/ai/openai.svg', mono: true },
  { name: 'Claude', href: `https://claude.ai/new?q=${q}`, icon: '/ai/claude-color.svg' },
  { name: 'Gemini', href: `https://www.google.com/search?udm=50&q=${q}`, icon: '/ai/gemini-color.svg' },
  { name: 'Perplexity', href: `https://www.perplexity.ai/search/new?q=${q}`, icon: '/ai/perplexity-color.svg' },
  { name: 'Grok', href: `https://grok.com/?q=${q}`, icon: '/ai/grok.svg', mono: true },
  { name: 'Copilot', href: `https://copilot.microsoft.com/?q=${q}`, icon: '/ai/copilot-color.svg' },
];

function Icon({ src, mono }: { src: string; mono?: boolean | undefined }) {
  if (mono) {
    // Single-colour marks follow the text colour, so they read in both themes.
    return <span aria-hidden className="size-4 shrink-0 bg-current" style={{ mask: `url(${src}) center / contain no-repeat`, WebkitMask: `url(${src}) center / contain no-repeat` }} />;
  }
  return <img src={src} alt="" aria-hidden className="size-4 shrink-0" />;
}

export function AskAi() {
  return (
    <div className="mt-8 rounded-2xl border border-fg/10 bg-gradient-to-br from-accent/[0.07] to-transparent p-5">
      <p className="flex items-center gap-2.5 text-sm font-medium text-fg">
        <ThemedMark className="size-5" />
        Ask your AI about OCSO
      </p>
      <p className="mt-1.5 text-sm text-fg/55">Get a plain-language briefing from your assistant of choice, grounded in this site and the code.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {ASSISTANTS.map((a) => (
          <a
            key={a.name}
            href={a.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-fg/12 bg-bg px-3 py-1.5 text-sm text-fg/80 transition hover:-translate-y-0.5 hover:border-accent/50 hover:text-fg"
          >
            <Icon src={a.icon} mono={a.mono} />
            {a.name}
          </a>
        ))}
      </div>
    </div>
  );
}
