import { describe, expect, it } from 'vitest';
import { createSlackChannelAdapter, slackPlainText } from '../src/index.js';
import { blockActionsBody, BOT_USER, CHANNEL, DM, dmEvent, eventCallback, mentionEvent, NOW, slackRequest, slConfig, TEAM, USER } from './helpers/slack.js';

const adapter = createSlackChannelAdapter({ now: () => NOW });
const parse = (body: string, settings: Record<string, unknown> = {}) => adapter.parseInbound(slackRequest(body), slConfig(settings));

describe('Slack inbound — events', () => {
  it('turns a DM into a text message from slack_user <team>:<user>, deduped on event_id, replying in the DM', () => {
    const envelope = parse(eventCallback(dmEvent({ user_profile: { display_name: 'Asha', real_name: 'Asha Rao' } })));
    expect(envelope).toMatchObject({ statuses: [], ignored: 0 });
    expect(envelope.messages).toEqual([
      {
        externalMessageId: 'Ev0EVENT001',
        identityKind: 'slack_user',
        identityValue: `${TEAM}:${USER}`,
        alternateIdentities: [],
        profileName: 'Asha',
        receivedAt: new Date(1790244000000),
        parts: [{ type: 'TEXT', text: 'Where is my card?' }],
        replyContext: { teamId: TEAM, channel: DM },
      },
    ]);
  });

  it('keeps a DM thread when the customer wrote in one', () => {
    const [message] = parse(eventCallback(dmEvent({ thread_ts: '1790243000.000001' }))).messages;
    expect(message?.replyContext).toEqual({ teamId: TEAM, channel: DM, threadTs: '1790243000.000001' });
  });

  it('turns an @mention into a message with the bot mention stripped, answered in a thread under it', () => {
    const [message] = parse(eventCallback(mentionEvent())).messages;
    expect(message?.parts).toEqual([{ type: 'TEXT', text: 'can you help with <refunds>?' }]);
    expect(message?.replyContext).toEqual({ teamId: TEAM, channel: CHANNEL, threadTs: '1790244000.000200' });
  });

  it('answers a mention in the channel when replyInThread is off, but stays in an existing thread', () => {
    expect(parse(eventCallback(mentionEvent()), { replyInThread: false }).messages[0]?.replyContext).toEqual({ teamId: TEAM, channel: CHANNEL });
    expect(parse(eventCallback(mentionEvent({ thread_ts: '1790240000.000009' })), { replyInThread: false }).messages[0]?.replyContext).toEqual({
      teamId: TEAM,
      channel: CHANNEL,
      threadTs: '1790240000.000009',
    });
  });

  it('follows respondTo and allowedChannelIds', () => {
    expect(parse(eventCallback(dmEvent()), { respondTo: 'mentions' })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(eventCallback(mentionEvent()), { respondTo: 'dm' })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(eventCallback(mentionEvent()), { allowedChannelIds: ['C0OTHER01'] })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(eventCallback(mentionEvent()), { allowedChannelIds: ['C0SUPPORT1'] })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(eventCallback(mentionEvent()), { allowedChannelIds: [CHANNEL.toLowerCase()] }).messages).toHaveLength(1);
    // DMs are not limited by the channel allowlist.
    expect(parse(eventCallback(dmEvent()), { allowedChannelIds: ['C0OTHER01'] }).messages).toHaveLength(1);
  });

  it.each([
    ['a bot message', dmEvent({ bot_id: 'B0BOT0001', subtype: 'bot_message' })],
    ['OCSO’s own message', dmEvent({ user: BOT_USER })],
    ['an edit', dmEvent({ subtype: 'message_changed' })],
    ['an edited message', dmEvent({ edited: { user: USER, ts: '1790244001.000000' } })],
    ['a deletion', dmEvent({ subtype: 'message_deleted' })],
    ['a channel join', dmEvent({ subtype: 'channel_join' })],
    ['a channel message (not a DM)', dmEvent({ channel_type: 'channel', channel: CHANNEL })],
    ['an empty message', dmEvent({ text: `<@${BOT_USER}>` })],
    ['a reaction', { type: 'reaction_added', user: USER, reaction: 'thumbsup', item: { type: 'message', channel: DM, ts: '1.2' } }],
    ['a message without a user', dmEvent({ user: undefined })],
  ])('ignores %s', (_label, event) => {
    expect(parse(eventCallback(event))).toEqual({ messages: [], statuses: [], ignored: 1 });
  });

  it('ignores unknown bodies instead of throwing', () => {
    expect(parse('not json')).toEqual({ messages: [], statuses: [], ignored: 1 });
    expect(parse(JSON.stringify({ type: 'app_rate_limited', team_id: TEAM }))).toEqual({ messages: [], statuses: [], ignored: 1 });
  });

  it('accepts a file share with text (the file itself is not imported)', () => {
    const [message] = parse(eventCallback(dmEvent({ subtype: 'file_share', text: 'see attached', files: [{ id: 'F1' }] }))).messages;
    expect(message?.parts).toEqual([{ type: 'TEXT', text: 'see attached' }]);
  });
});

describe('Slack inbound — button taps', () => {
  it('turns a tap on an OCSO choice button into a STRUCTURED button_reply with the option id', () => {
    const envelope = parse(blockActionsBody({ action_id: 'ocso.choice:cards', value: 'cards', text: { type: 'plain_text', text: 'Cards' } }));
    expect(envelope.messages).toEqual([
      {
        externalMessageId: `action:${DM}:1790244100.000300:${USER}:1790244110.123456`,
        identityKind: 'slack_user',
        identityValue: `${TEAM}:${USER}`,
        alternateIdentities: [],
        profileName: 'asha',
        receivedAt: new Date(1790244110123),
        parts: [{ type: 'STRUCTURED', schema: 'button_reply', data: { id: 'cards', title: 'Cards', source: 'slack' }, fallbackText: 'Cards' }],
        replyToExternalId: `${DM}:1790244100.000300`,
        replyContext: { teamId: TEAM, channel: DM },
      },
    ]);
  });

  it('keeps the thread of a button message posted in a thread', () => {
    const body = blockActionsBody(
      { action_id: 'ocso.choice:loans', value: 'loans', block_id: `ocso.choices:${USER}`, text: { type: 'plain_text', text: 'Loans' } },
      { container: { type: 'message', message_ts: '1790244100.000300', channel_id: CHANNEL, thread_ts: '1790244000.000200' }, message: { ts: '1790244100.000300', thread_ts: '1790244000.000200' } },
    );
    expect(parse(body).messages[0]?.replyContext).toEqual({ teamId: TEAM, channel: CHANNEL, threadTs: '1790244000.000200' });
  });

  it('applies respondTo and allowedChannelIds to clicks as to messages', () => {
    const tap = { action_id: 'ocso.choice:cards', value: 'cards', block_id: `ocso.choices:${USER}` };
    const inChannel = (channel: string) => blockActionsBody(tap, { container: { type: 'message', message_ts: '1790244100.000300', channel_id: channel }, channel: { id: channel } });
    expect(parse(blockActionsBody(tap)).messages).toHaveLength(1);
    expect(parse(blockActionsBody(tap), { respondTo: 'mentions' })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel(CHANNEL)).messages).toHaveLength(1);
    expect(parse(inChannel(CHANNEL), { respondTo: 'dm' })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel(CHANNEL), { allowedChannelIds: ['C0OTHER0001'] })).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel(CHANNEL), { allowedChannelIds: [CHANNEL] }).messages).toHaveLength(1);
  });

  it('takes a click only from the user the buttons were addressed to', () => {
    const inChannel = (blockId: string, user = USER) =>
      blockActionsBody(
        { action_id: 'ocso.choice:cards', value: 'cards', block_id: blockId },
        { user: { id: user, team_id: TEAM }, container: { type: 'message', message_ts: '1790244100.000300', channel_id: CHANNEL }, channel: { id: CHANNEL } },
      );
    expect(parse(inChannel(`ocso.choices:${USER}`, 'U0SOMEONE01'))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel('ocso.choices'))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel('other.block'))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(inChannel(`ocso.choices:${USER}`)).messages).toHaveLength(1);
    // An unaddressed block in a DM: only the DM's member can press it.
    expect(parse(blockActionsBody({ action_id: 'ocso.choice:cards', value: 'cards', block_id: 'ocso.choices' })).messages).toHaveLength(1);
  });

  it('ignores other apps’ actions and other interaction types', () => {
    expect(parse(blockActionsBody({ action_id: 'approve_expense', value: '1' }))).toMatchObject({ messages: [], ignored: 1 });
    expect(parse(new URLSearchParams({ payload: JSON.stringify({ type: 'view_submission', user: { id: USER } }) }).toString())).toMatchObject({ messages: [], ignored: 1 });
  });
});

describe('Slack message text', () => {
  it('reads users, channels, links and broadcasts, and strips only the app’s own mention', () => {
    expect(slackPlainText(`<@${BOT_USER}> ping <@U0OTHER01|maya> in <#C0GENERAL|general> about <https://x.example/a?b=1&amp;c=2|the doc> <!here>`, BOT_USER)).toBe(
      'ping @maya in #general about the doc (https://x.example/a?b=1&c=2) @here',
    );
    expect(slackPlainText('mail <mailto:a@b.example|a@b.example> &amp; 5 &gt; 3')).toBe('mail a@b.example & 5 > 3');
  });
});
