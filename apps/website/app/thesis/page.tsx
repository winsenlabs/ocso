import type { Metadata } from 'next';
import { Hero } from '@/components/HeroSection';
import { ThesisBody } from '@/components/sections/Thesis';
import { RequestDemo } from '@/components/Ctas';
import { FILM_SHARE } from '@/content/links';

const TITLE = 'Our thesis — OCSO';
const DESCRIPTION =
  'Customer service is where a company keeps its promises. Why OCSO is one layer for AI agents and people, and why everything that touches the outside world is a plugin.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/thesis' },
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'article', url: '/thesis', ...FILM_SHARE.openGraph },
  twitter: { title: TITLE, description: DESCRIPTION, ...FILM_SHARE.twitter },
  other: FILM_SHARE.other,
};

export default function ThesisPage() {
  return (
    <>
      <Hero eyebrow="Our thesis" title="One company, whoever answers.">
        Customer service is where a company keeps its promises. We believe it should feel like one caring team, whether a person or an AI agent answers. We
        built OCSO from that belief instead of bolting AI onto the tools we already had.
      </Hero>
      <ThesisBody />
      <section className="mx-auto max-w-6xl px-6 pb-24 pt-16">
        <div className="on-dark flex flex-col items-start gap-5 rounded-3xl bg-[#0b1024] p-8 md:flex-row md:items-center md:justify-between md:p-10">
          <p className="max-w-xl text-lg text-fg/80">See it on your own customer service: your channels, your models, your systems.</p>
          <RequestDemo />
        </div>
      </section>
    </>
  );
}
