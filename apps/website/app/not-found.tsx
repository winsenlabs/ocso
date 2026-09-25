import type { Metadata } from 'next';
import { Footer } from '@/components/footer';
import { Header } from '@/components/header';

export const metadata: Metadata = { title: 'Page not found — OCSO', robots: { index: false } };

export default function NotFound() {
  return (
    <>
      <Header />
      <main id="main" className="notfound wrap">
        <p className="eyebrow">404</p>
        <h1>This route has no queue.</h1>
        <p className="lede">The page you asked for does not exist. The rest of OCSO is one page away.</p>
        <p>
          <a className="btn btn-primary" href="/">
            Back to the home page
          </a>
        </p>
      </main>
      <Footer />
    </>
  );
}
