import { repo } from '@/lib/site';
import { Icon, type IconName } from './icons';
import { Section } from './section';

interface Channel {
  readonly name: string;
  readonly via: string;
  readonly icon: IconName;
  readonly body: string;
}

const CHANNELS: readonly Channel[] = [
  {
    name: 'WhatsApp',
    via: 'Meta Cloud API or Twilio',
    icon: 'phone',
    body: 'Connect a number directly through Meta or through Twilio. Images, voice notes, video, documents and locations arrive as typed message parts, not flattened text.',
  },
  {
    name: 'Web chat',
    via: 'One script tag, or your own UI',
    icon: 'browser',
    body: 'Embed the widget with one script tag, or build your own chat on the chat SDK. Customers can stay anonymous or arrive signed in with your login.',
  },
  {
    name: 'Slack',
    via: 'Direct messages and @mentions',
    icon: 'hash',
    body: 'People message your Slack app or @mention it in a channel. OCSO answers in the DM, or in a thread under the mention.',
  },
  {
    name: 'Microsoft Teams',
    via: 'Azure Bot, chats and channels',
    icon: 'people',
    body: 'People chat with your bot one to one, or @mention it in a group chat or channel. Requests are verified against Microsoft’s signing keys.',
  },
];

export function Channels() {
  return (
    <Section
      id="channels"
      index="01"
      eyebrow="Channels"
      title="Meet customers where they already write."
      intro="Every channel is a plugin behind one contract. The conversation model, handoff, audit and analytics are the same whichever one a customer uses."
    >
      <ul className="channel-grid">
        {CHANNELS.map((c) => (
          <li key={c.name} className="card channel">
            <span className="channel-icon">
              <Icon name={c.icon} size={22} />
            </span>
            <h3>{c.name}</h3>
            <p className="channel-via">{c.via}</p>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      <p className="footnote">
        Need another channel? Write one against the same contract.{' '}
        <a href={repo('docs/plugins/add-a-channel.md')}>Add a channel in seven steps</a>.
      </p>
    </Section>
  );
}
