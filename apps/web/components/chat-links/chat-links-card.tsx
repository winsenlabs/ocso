import { SecHead } from '@/components/ui/sec-head';
import type { ChatLink } from '@/lib/api/chat-links';
import { formatDateTime } from '@/lib/format';
import { RevokeChatLink } from './revoke-chat-link';

/**
 * Chat accounts linked to Ask OCSO (Slack, Teams): channel, chat account, when linked and last used, each with
 * Revoke (immediate). On Account for the signed-in user; on a user's drawer for a Tech admin with users.manage.
 */
export function ChatLinksCard({ links, timeZone, whose }: { links: ChatLink[]; timeZone: string; whose: 'mine' | { name: string } }) {
  const empty =
    whose === 'mine'
      ? 'None yet. Message the Ask OCSO app in Slack or Teams and follow the link it sends to link your chat account.'
      : `${whose.name} has not linked a chat account.`;
  return (
    <section className="ch sec-card" aria-label="Chat accounts">
      <SecHead title="Chat accounts" count={links.length} desc={whose === 'mine' ? 'Ask OCSO in Slack or Teams, as you · revoking takes effect at once' : 'Ask OCSO in chat as this user · revoking takes effect at once'} />
      <div>
        {links.length === 0 ? <span className="mono-sm">{empty}</span> : null}
        {links.map((l) => (
          <div className="sec-row" key={l.id}>
            <div className="sec-main">
              <b>
                {l.network} · {l.profileName ? `${l.profileName} (${l.identity})` : l.identity}
              </b>
              <span className="mono-sm">
                channel {l.channel.name} · linked {formatDateTime(l.createdAt, timeZone)} · last used {l.lastUsedAt ? formatDateTime(l.lastUsedAt, timeZone) : 'never'}
              </span>
            </div>
            <RevokeChatLink id={l.id} label={`${l.network} ${l.profileName ?? l.identity}`} />
          </div>
        ))}
      </div>
    </section>
  );
}
