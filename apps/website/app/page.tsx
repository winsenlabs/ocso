import { AskOcso } from '@/components/ask-ocso';
import { Build } from '@/components/build';
import { Channels } from '@/components/channels';
import { FinalCta } from '@/components/final-cta';
import { Footer } from '@/components/footer';
import { Governance } from '@/components/governance';
import { Header } from '@/components/header';
import { Hero } from '@/components/hero';
import { HowItWorks } from '@/components/how-it-works';
import { SelfHost } from '@/components/self-host';

export default function HomePage() {
  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <Channels />
        <HowItWorks />
        <Governance />
        <AskOcso />
        <Build />
        <SelfHost />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
