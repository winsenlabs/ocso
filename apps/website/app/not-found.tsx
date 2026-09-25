import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Page not found — OCSO', robots: { index: false } };

export default function NotFound() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-32 text-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">404</p>
      <h1 className="mt-4 text-5xl font-medium tracking-[-0.03em] text-fg">This route has no queue.</h1>
      <p className="mt-4 text-lg text-fg/60">The page you asked for does not exist. Everything about OCSO is on one page.</p>
      <a href="/" className="mt-10 inline-block rounded-full bg-fg px-6 py-3 font-medium text-bg hover:bg-fg/90">
        Back to the home page
      </a>
    </section>
  );
}
