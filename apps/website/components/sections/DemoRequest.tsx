import { WINSEN_URL, helloEmail } from '@/content/links';
import { DemoForm } from '../DemoForm';
import { Heading } from '../Heading';

export function DemoRequest() {
  return (
    <section id="demo" className="mx-auto max-w-6xl scroll-mt-24 px-6 pb-24 pt-24">
      <Heading
        eyebrow="Request a demo"
        title="See OCSO on your customer success."
        lede="Tell us who you are and how your team serves customers. We’ll reply to set up a walkthrough shaped around your channels and volumes."
      />
      <div className="mt-12 rounded-3xl border border-fg/10 bg-fg/[0.02] p-6 md:p-9">
        <DemoForm />
      </div>
      <div className="mt-12 grid gap-10 text-sm md:grid-cols-3">
        <div>
          <p className="text-fg/40">What happens next</p>
          <ol className="mt-3 space-y-3 text-fg/75">
            <li className="flex gap-3">
              <span className="font-mono text-accent">01</span>You get a confirmation email straight away.
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-accent">02</span>Someone from Winsen Labs reads your answers and replies.
            </li>
            <li className="flex gap-3">
              <span className="font-mono text-accent">03</span>We walk your team through OCSO, set up around how you serve customers.
            </li>
          </ol>
        </div>
        <div>
          <p className="text-fg/40">Email</p>
          <a href={`mailto:${helloEmail}`} className="mt-1 block text-lg text-fg hover:text-accent">
            {helloEmail}
          </a>
        </div>
        <div>
          <p className="text-fg/40">Winsen Labs</p>
          <a href={WINSEN_URL} className="mt-1 block text-lg text-fg hover:text-accent">
            winsenlabs.com
          </a>
          <p className="mt-1 text-fg/50">The applied AI lab behind OCSO.</p>
        </div>
      </div>
    </section>
  );
}
