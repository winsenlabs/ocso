import { describe, expect, it } from 'vitest';
import { definePlugin, type EmbeddedChat } from '../src/index.js';
import { checkPlugin } from '../src/testing/index.js';
import { channel, destination, emailDriver, provider } from './helpers.js';

const embed: EmbeddedChat = {
  widgetConfig: () => ({ allowedOrigins: [], branding: {}, maxAttachmentsPerMessage: 1, hostIdentity: false, authMode: 'anonymous', allowNativeApps: false }),
  openSession: () => Promise.reject(new Error('unused')),
  identify: () => Promise.reject(new Error('unused')),
  attachmentKeyPrefix: () => 'x/',
};

const valid = definePlugin({
  apiVersion: 1,
  name: '@acme/ocso-test',
  channels: [() => channel()],
  modelProviders: [provider()],
  alertDestinations: [() => destination()],
  emailDrivers: [emailDriver()],
});

function problemsWith(patch: Record<string, unknown>): string[] {
  return checkPlugin({ ...valid, ...patch });
}

describe('checkPlugin', () => {
  it('accepts a valid plugin with one contribution of each kind', () => {
    expect(checkPlugin(valid)).toEqual([]);
    expect(checkPlugin({ apiVersion: 1, name: 'empty' })).toEqual([]);
  });

  it('checks the envelope: object, apiVersion, name, keys', () => {
    expect(checkPlugin(null)).toEqual([expect.stringContaining('must be an object')]);
    expect(problemsWith({ apiVersion: 2 })).toEqual([expect.stringContaining('apiVersion must be 1')]);
    expect(problemsWith({ apiVersion: undefined })).toEqual([expect.stringContaining('got undefined')]);
    expect(problemsWith({ name: '  ' })).toEqual([expect.stringContaining('needs a name')]);
    expect(problemsWith({ name: ' x ' })).toEqual([expect.stringContaining('leading or trailing spaces')]);
    expect(problemsWith({ toolProviders: [] })).toEqual(['toolProviders cannot be contributed by a plugin in plugin API version 1']);
    expect(problemsWith({ name: 'a'.repeat(215) })).toEqual([expect.stringContaining('at most 214')]);
    expect(problemsWith({ name: 'a'.repeat(214) })).toEqual([]);
    expect(problemsWith({ name: '@ocso/evil' })).toEqual([expect.stringContaining('reserved')]);
    expect(problemsWith({ name: '@ocso-examples/fine' })).toEqual([]);
    // OCSO's loader ignores extra keys, so checkPlugin does too.
    expect(problemsWith({ widgets: [], version: '1' })).toEqual([]);
    expect(problemsWith({ channels: {} })).toEqual(['channels must be an array']);
  });

  it('runs the channel registry checks', () => {
    const check = (...factories: unknown[]) => problemsWith({ channels: factories });
    expect(check('nope')).toEqual([expect.stringContaining('must be a factory function')]);
    expect(
      check(() => {
        throw new Error('boom');
      }),
    ).toEqual(['channels[0]: the factory threw: boom']);
    expect(check(() => channel({ kind: 'lower' }))).toEqual([expect.stringContaining('invalid channel kind "lower"')]);
    expect(check(() => channel(), () => channel())).toEqual([expect.stringContaining('contributed twice')]);
    expect(check(() => channel({}, { kind: 'OTHER' }))).toEqual([expect.stringContaining('describes itself as OTHER')]);
    expect(check(() => channel({}, { mark: { code: 'TOOLONG', name: 'x' } }))).toEqual([expect.stringContaining('invalid mark code')]);
    expect(check(() => channel({}, { embeddable: true }))).toEqual([expect.stringContaining('embeddable kinds')]);
    // A plain-JS descriptor without `embeddable`: OCSO's registry compares it strictly, so it is refused even without embed hooks.
    expect(check(() => channel({}, { embeddable: undefined } as never))).toEqual([expect.stringContaining('embeddable kinds')]);
    expect(check(() => channel({ embed }))).toEqual([expect.stringContaining('embeddable kinds')]);
    expect(check(() => channel({ embed }, { embeddable: true }))).toEqual([]);
    expect(check(() => channel({ embed: { ...embed, identify: undefined } as unknown as EmbeddedChat }, { embeddable: true }))).toEqual([
      expect.stringContaining('missing embed hooks: identify'),
    ]);
    const listTemplates = () => Promise.resolve([]);
    const terms = { templates: { reviewer: 'x', placeholderScope: 'template' as const } };
    expect(check(() => channel({ listTemplates }, terms))).toEqual([expect.stringContaining('message templates')]);
    expect(check(() => channel({ listTemplates, createTemplate: () => Promise.reject(new Error('x')), sendTemplate: () => Promise.reject(new Error('x')) }))).toEqual([
      expect.stringContaining('message templates'),
    ]);
    expect(check(() => channel({ listTemplates, createTemplate: () => Promise.reject(new Error('x')), sendTemplate: () => Promise.reject(new Error('x')) }, terms))).toEqual([]);
    expect(check(() => channel({}, { templates: { reviewer: 'x', placeholderScope: 'template' } }))).toEqual([expect.stringContaining('message templates')]);
    expect(check(() => channel({}, { webhookSegment: 'Bad Segment' }))).toEqual([expect.stringContaining('invalid webhook segment')]);
    expect(check(() => channel({ kind: 'A_B' }), () => channel({ kind: 'C_D' }, { webhookSegment: 'a-b' }))).toEqual([
      expect.stringContaining('webhook segment "a-b" is used twice'),
    ]);
    expect(check(() => channel({ kind: 'A_B' }, { inboundWebhook: false, webhookSegment: 'Bad' }))).toEqual([]);
    expect(check(() => channel({ send: undefined } as never))).toEqual([expect.stringContaining('missing adapter methods: send')]);
  });

  it('runs the model provider registry checks', () => {
    expect(problemsWith({ modelProviders: [provider({ kind: 'bad-kind' })] })).toEqual([expect.stringContaining('UPPER_SNAKE_CASE')]);
    expect(problemsWith({ modelProviders: [provider(), provider()] })).toEqual([expect.stringContaining('contributed twice')]);
    expect(problemsWith({ modelProviders: [provider({ settingsSchema: {} as never })] })).toEqual([expect.stringContaining('settingsSchema must be a zod schema')]);
    expect(problemsWith({ modelProviders: [{ ...provider(), create: 1 }] })).toEqual([expect.stringContaining('missing definition methods: create')]);
  });

  it('runs the alert destination registry checks', () => {
    const check = (...adapters: ReturnType<typeof destination>[]) => problemsWith({ alertDestinations: adapters.map((a) => () => a) });
    expect(check(destination({ kind: 'Slack' }))).toEqual([expect.stringContaining('must be upper snake case')]);
    expect(check(destination(), destination())).toEqual([expect.stringContaining('contributed twice')]);
    expect(check(destination({ events: [] }))).toEqual([expect.stringContaining('known lifecycle events')]);
    expect(check(destination({ events: ['OPENED', 'EXPLODED' as never] }))).toEqual([expect.stringContaining('known lifecycle events')]);
  });

  it('runs the email driver registry checks', () => {
    expect(problemsWith({ emailDrivers: [emailDriver({ name: 'Bad_Name' })] })).toEqual([expect.stringContaining('must be lower case')]);
    expect(problemsWith({ emailDrivers: [emailDriver(), emailDriver()] })).toEqual([expect.stringContaining('contributed twice')]);
  });

  it('gives factories dependencies without network access', async () => {
    let fetched: Promise<Response> | null = null;
    checkPlugin({
      apiVersion: 1,
      name: 'probe',
      channels: [
        (deps: { fetch: (u: string) => Promise<Response> }) => {
          fetched = deps.fetch('https://example.com');
          fetched.catch(() => undefined);
          return channel();
        },
      ],
    });
    await expect(fetched).rejects.toThrow('no network');
  });
});
