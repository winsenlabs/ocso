import { describe, expect, it } from 'vitest';
import { createMsTeamsAdapter, teamsMessageId } from '../src/index.js';
import { activity, BOT_ID, BYSTANDER_AAD, CHANNEL_CONVERSATION, mentionActivity, mtConfig, NOW, OTHER_TENANT, PERSONAL_CONVERSATION, SERVICE_URL, teamsRequest, TENANT, USER_AAD } from './helpers/teams.js';

const adapter = createMsTeamsAdapter({ now: () => NOW });
const parse = (body: unknown, config = mtConfig()) => adapter.parseInbound(teamsRequest(body, 'unused'), config);

describe('Teams inbound — messages', () => {
  it('turns a personal chat message into a text message from teams_user <tenant>:<object id> with its conversation reference', () => {
    const envelope = parse(activity());
    expect(envelope).toMatchObject({ statuses: [], ignored: 0 });
    expect(envelope.messages).toEqual([
      {
        externalMessageId: teamsMessageId(PERSONAL_CONVERSATION, '1790244000456'),
        identityKind: 'teams_user',
        identityValue: `${TENANT}:${USER_AAD}`,
        alternateIdentities: [],
        profileName: 'Asha Rao',
        receivedAt: NOW,
        parts: [{ type: 'TEXT', text: 'Where is my card?' }],
        replyContext: { serviceUrl: SERVICE_URL, conversationId: PERSONAL_CONVERSATION, conversationType: 'personal', tenantId: TENANT, botId: BOT_ID },
      },
    ]);
  });

  it('strips the bot’s own @mention in a channel, decodes entities, and keeps the channel thread as the reply context', () => {
    const [message] = parse(mentionActivity()).messages;
    expect(message?.parts).toEqual([{ type: 'TEXT', text: 'can you help with <refunds>?' }]);
    expect(message?.replyContext).toEqual({ serviceUrl: SERVICE_URL, conversationId: CHANNEL_CONVERSATION, conversationType: 'channel', tenantId: TENANT, botId: BOT_ID });
  });

  it('keeps other people’s mentions as @Name and turns light HTML into text', () => {
    const [message] = parse(
      mentionActivity({
        text: '<at>OCSO Assistant</at> please ask <at>Ravi</at><br>about <strong>refunds</strong>&nbsp;today',
        entities: [
          { type: 'mention', text: '<at>OCSO Assistant</at>', mentioned: { id: BOT_ID, name: 'OCSO Assistant' } },
          { type: 'mention', text: '<at>Ravi</at>', mentioned: { id: '29:ravi', name: 'Ravi' } },
        ],
      }),
    ).messages;
    expect(message?.parts).toEqual([{ type: 'TEXT', text: 'please ask @Ravi\nabout refunds today' }]);
  });

  it('dedupes on the activity id scoped to its conversation', () => {
    const a = parse(activity()).messages[0]!.externalMessageId;
    expect(parse(activity()).messages[0]!.externalMessageId).toBe(a);
    expect(parse(activity({ conversation: { id: 'a:other', conversationType: 'personal', tenantId: TENANT } })).messages[0]!.externalMessageId).not.toBe(a);
    expect(a).toMatch(/^teams:[0-9a-f]{24}:1790244000456$/);
  });

  it('reads the tenant from channelData when the conversation has none', () => {
    const [message] = parse(activity({ conversation: { id: PERSONAL_CONVERSATION, conversationType: 'personal' } })).messages;
    expect(message?.identityValue).toBe(`${TENANT}:${USER_AAD}`);
  });
});

describe('Teams inbound — ignored activities', () => {
  it.each([
    ['conversationUpdate (bot added)', activity({ type: 'conversationUpdate', text: undefined, membersAdded: [{ id: BOT_ID }] })],
    ['typing', activity({ type: 'typing', text: undefined })],
    ['messageReaction', activity({ type: 'messageReaction', text: undefined })],
    ['invoke', activity({ type: 'invoke', name: 'adaptiveCard/action' })],
    ['installationUpdate', activity({ type: 'installationUpdate', action: 'add' })],
    ['the Azure portal Web Chat test', activity({ channelId: 'webchat' })],
    ['the bot’s own message', activity({ from: { id: BOT_ID, aadObjectId: USER_AAD } })],
    ['a sender without an Entra object id (guest via federation)', activity({ from: { id: '29:anon' } })],
    ['another tenant on a single-tenant bot', activity({ conversation: { id: PERSONAL_CONVERSATION, conversationType: 'personal', tenantId: OTHER_TENANT } })],
    ['an attachment without text', activity({ text: '', attachments: [{ contentType: 'image/png', contentUrl: 'https://x' }] })],
    ['a message that is only the bot’s mention', mentionActivity({ text: '<at>OCSO Assistant</at> ' })],
    ['a message without an id', activity({ id: undefined })],
  ])('%s', (_name, body) => {
    expect(parse(body)).toEqual({ messages: [], statuses: [], ignored: 1 });
  });

  it('a multi-tenant bot takes other tenants', () => {
    const body = activity({ conversation: { id: PERSONAL_CONVERSATION, conversationType: 'personal', tenantId: OTHER_TENANT } });
    expect(parse(body, mtConfig({ appType: 'MultiTenant', tenantId: undefined })).messages[0]?.identityValue).toBe(`${OTHER_TENANT}:${USER_AAD}`);
  });

  it('throws a typed validation error for a body that is not an activity', () => {
    expect(() => parse('not json')).toThrow('activity body is empty, too large or not JSON');
    expect(() => parse({ hello: 'world' })).toThrow('body is not a Bot Framework activity');
  });
});

describe('Teams inbound — choice card taps (Action.Submit)', () => {
  const tap = (value: unknown, overrides: Record<string, unknown> = {}) => activity({ id: '1790244100999', text: undefined, value, replyToId: '1790244100001', ...overrides });

  it('turns a button tap into the STRUCTURED button_reply routers understand', () => {
    const [message] = parse(tap({ ocso: 'choice', id: 'loans', label: 'Loans', for: USER_AAD })).messages;
    expect(message?.parts).toEqual([{ type: 'STRUCTURED', schema: 'button_reply', data: { id: 'loans', title: 'Loans', source: 'teams' }, fallbackText: 'Loans' }]);
  });

  it('turns a drop-down choice (list card) into the same reply, only for an option the card offered', () => {
    const labels = { cards: 'Cards', loans: 'Loans' };
    expect(parse(tap({ ocso: 'choice', labels, ocsoChoice: 'cards', for: USER_AAD })).messages[0]?.parts).toEqual([
      { type: 'STRUCTURED', schema: 'button_reply', data: { id: 'cards', title: 'Cards', source: 'teams' }, fallbackText: 'Cards' },
    ]);
    expect(parse(tap({ ocso: 'choice', labels, ocsoChoice: 'forged', for: USER_AAD }))).toMatchObject({ messages: [], ignored: 1 });
  });

  it('ignores a tap by someone other than the person asked (anyone in a channel sees the card)', () => {
    const bystander = tap({ ocso: 'choice', id: 'loans', label: 'Loans', for: USER_AAD }, { from: { id: '29:ravi', name: 'Ravi', aadObjectId: BYSTANDER_AAD } });
    expect(parse(bystander)).toMatchObject({ messages: [], ignored: 1 });
    // Case-insensitive match for the addressee.
    expect(parse(tap({ ocso: 'choice', id: 'loans', for: USER_AAD.toUpperCase() })).messages).toHaveLength(1);
  });

  it('treats values that are not OCSO choices as ordinary messages', () => {
    expect(parse(tap({ something: 'else' }, { text: 'hello' })).messages[0]?.parts).toEqual([{ type: 'TEXT', text: 'hello' }]);
    expect(parse(tap({ something: 'else' }))).toMatchObject({ messages: [], ignored: 1 });
  });
});
