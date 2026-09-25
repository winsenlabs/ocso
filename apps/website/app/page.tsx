import { Hero } from '@/components/HeroSection';
import { BuildWithYou } from '@/components/sections/BuildWithYou';
import { DemoRequest } from '@/components/sections/DemoRequest';
import { Governance } from '@/components/sections/Governance';
import { OcsoWay } from '@/components/sections/OcsoWay';
import { OpenSource } from '@/components/sections/OpenSource';
import { Problem } from '@/components/sections/Problem';
import { NAME } from '@/content/links';

export default function Home() {
  return (
    <>
      <Hero
        eyebrow={NAME}
        title={
          <>
            <span className="whitespace-nowrap">Customer success,</span>
            <br />
            <span className="underline decoration-accent decoration-[3px] underline-offset-[10px] md:decoration-4 md:underline-offset-[14px]">rethought</span> for the AI age.
          </>
        }
        stats={[
          ['Channels', 'WhatsApp · web chat · Slack · Teams'],
          ['Governed', 'maker–checker on every change'],
          ['Open source', 'Apache-2.0, self-hosted'],
        ]}
      >
        <span className="lg:block">Today customer success is scattered across channels, tools and teams, with AI bolted on at the edges.</span>{' '}
        OCSO is the open orchestration layer where AI agents and your people serve customers together on WhatsApp, web chat, Slack and Teams.
        Every configuration change is approved by a second person and written to a signed audit trail.
      </Hero>
      <BuildWithYou />
      <Problem />
      <OcsoWay />
      <Governance />
      <OpenSource />
      <DemoRequest />
    </>
  );
}
