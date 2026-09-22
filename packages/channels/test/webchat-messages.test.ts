import { describe, expect, it } from 'vitest';
import type { InteractionPart } from '@ocso/domain';
import { ChannelMediaError, createWebChatAdapter, type RenderedOutbound } from '../src/index.js';
import { NOW, wcConfig, widgetRequest } from './helpers/webchat.js';

const adapter = createWebChatAdapter({ now: () => NOW, generateId: () => 'fixed-id' });
const config = wcConfig();
const visitor = adapter.issueVisitorToken(config, { visitorId: 'v_visitor_one' });
const identity = { identityKind: 'webchat_visitor', identityValue: 'v_visitor_one' };
const prefix = adapter.attachmentKeyPrefix(config, identity);

const parse = (body: unknown, token = visitor.token) => adapter.parseInbound(widgetRequest(token, body), config);
const attachment = (over: Record<string, unknown> = {}) => ({
  blobKey: `${prefix}upl_01J9ZK.jpg`,
  mimeType: 'image/jpeg',
  filename: 'receipt.jpg',
  sizeBytes: 48_213,
  ...over,
});

describe('web chat parseInbound', () => {
  it('normalizes text, stored attachments and structured input into one message', () => {
    const envelope = parse({
      clientMessageId: 'msg_01J9ZK4Q7F',
      text: 'Here is the receipt',
      attachments: [attachment(), attachment({ blobKey: `${prefix}upl_02.pdf`, mimeType: 'application/pdf', filename: '../../etc/statement.pdf' })],
      structured: { schema: 'button_reply', data: { id: 'yes' }, fallbackText: 'Yes' },
    });
    expect(envelope).toMatchObject({ statuses: [], ignored: 0 });
    const [message] = envelope.messages;
    expect(message).toMatchObject({ identityKind: 'webchat_visitor', identityValue: 'v_visitor_one', receivedAt: NOW });
    expect(message?.parts).toEqual([
      { type: 'TEXT', text: 'Here is the receipt' },
      {
        type: 'IMAGE',
        media: { status: 'STORED', blobKey: `${prefix}upl_01J9ZK.jpg`, mimeType: 'image/jpeg', sizeBytes: 48_213, filename: 'receipt.jpg', source: { channel: 'WEBCHAT' } },
      },
      {
        type: 'DOCUMENT',
        media: { status: 'STORED', blobKey: `${prefix}upl_02.pdf`, mimeType: 'application/pdf', sizeBytes: 48_213, filename: 'statement.pdf', source: { channel: 'WEBCHAT' } },
      },
      { type: 'STRUCTURED', schema: 'button_reply', data: { id: 'yes' }, fallbackText: 'Yes' },
    ]);
  });

  it('accepts uploadId as an alias for blobKey', () => {
    const [message] = parse({ clientMessageId: 'msg_upload_alias', attachments: [{ ...attachment(), blobKey: undefined, uploadId: `${prefix}u.png`, mimeType: 'image/png' }] }).messages;
    expect(message?.parts[0]).toMatchObject({ type: 'IMAGE', media: { blobKey: `${prefix}u.png` } });
  });

  it('gives a retried clientMessageId the same idempotency key, namespaced per sender', () => {
    const first = parse({ clientMessageId: 'msg_retry_0001', text: 'hi' }).messages[0]?.externalMessageId;
    const again = parse({ clientMessageId: 'msg_retry_0001', text: 'hi' }).messages[0]?.externalMessageId;
    const other = adapter.issueVisitorToken(config, { visitorId: 'v_visitor_two' }).token;
    const otherKey = parse({ clientMessageId: 'msg_retry_0001', text: 'hi' }, other).messages[0]?.externalMessageId;
    expect(first).toBe(again);
    expect(first).toMatch(/^webchat:[0-9a-f]{32}:msg_retry_0001$/);
    expect(otherKey).not.toBe(first);
  });

  it('rejects attachments that are disallowed, oversize, or owned by someone else', () => {
    const code = (body: unknown) => {
      try {
        parse(body);
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return 'no error';
    };
    expect(code({ clientMessageId: 'msg_type_bad1', attachments: [attachment({ mimeType: 'audio/ogg' })] })).toBe('webchat_attachment_type_not_allowed');
    expect(code({ clientMessageId: 'msg_type_bad2', attachments: [attachment({ mimeType: 'application/x-msdownload' })] })).toBe(
      'webchat_attachment_type_not_allowed',
    );
    expect(code({ clientMessageId: 'msg_too_big_1', attachments: [attachment({ sizeBytes: 11 * 1024 * 1024 })] })).toBe('webchat_attachment_too_large');
    expect(code({ clientMessageId: 'msg_not_mine1', attachments: [attachment({ blobKey: 'webchat/chn_webchat_site/someone-else/x.jpg' })] })).toBe(
      'webchat_attachment_not_owned',
    );
    expect(code({ clientMessageId: 'msg_traversal', attachments: [attachment({ blobKey: `${prefix}../other/x.jpg` })] })).toBe(
      'webchat_attachment_not_owned',
    );
    const six = Array.from({ length: 6 }, () => attachment());
    expect(code({ clientMessageId: 'msg_too_many1', attachments: six })).toBe('webchat_too_many_attachments');
  });

  it('rejects empty, oversized or malformed bodies with typed validation errors', () => {
    expect(() => parse({ clientMessageId: 'msg_empty_001', text: '   ' })).toThrowError(expect.objectContaining({ code: 'webchat_empty_message' }));
    expect(() => parse({ clientMessageId: 'msg_long_0001', text: 'x'.repeat(8_001) })).toThrowError(expect.objectContaining({ code: 'webchat_text_too_long' }));
    expect(() => parse({ clientMessageId: 'short', text: 'hi' })).toThrowError(expect.objectContaining({ code: 'webchat_invalid_message', category: 'validation' }));
    expect(() => parse('{oops')).toThrowError(expect.objectContaining({ code: 'webchat_invalid_json' }));
  });

  it('requires a valid token (auth error, never parses anonymous input)', () => {
    expect(() => adapter.parseInbound(widgetRequest(null, { clientMessageId: 'msg_no_token1', text: 'hi' }), config)).toThrowError(
      expect.objectContaining({ category: 'authentication', code: 'webchat_token_missing' }),
    );
  });
});

describe('web chat render, send and fetchMedia', () => {
  const toolResult: InteractionPart = { type: 'TOOL_RESULT', toolCallId: 'c1', toolName: 'crm__lookup', status: 'SUCCEEDED', summary: { secret: 'x' } };

  it('renders customer-safe parts into one message payload (commonmark untouched)', () => {
    const parts: InteractionPart[] = [
      { type: 'TEXT', text: 'Your **refund** is on its way.' },
      toolResult,
      { type: 'IMAGE', media: { status: 'STORED', blobKey: 'outbound/r.png', mimeType: 'image/png' } },
      { type: 'LOCATION', latitude: 1, longitude: 2 },
    ];
    expect(adapter.render(parts, config)).toEqual([
      {
        kind: 'WEBCHAT',
        payload: { type: 'message', parts: [parts[0], parts[2]] },
        partIndexes: [0, 2],
      },
    ]);
    expect(adapter.render([toolResult], config)).toEqual([]);
  });

  it('splits over-long text into several TEXT parts and refuses unstored media', () => {
    const [rendered] = adapter.render([{ type: 'TEXT', text: 'Sentence here. '.repeat(1000) }], config);
    const parts = (rendered?.payload['parts'] ?? []) as InteractionPart[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.type === 'TEXT' && p.text.length <= 8_000)).toBe(true);
    expect(() => adapter.render([{ type: 'DOCUMENT', media: { status: 'PENDING', mimeType: 'application/pdf' } }], config)).toThrowError(
      expect.objectContaining({ code: 'outbound_media_not_stored' }),
    );
  });

  it('send does no network I/O and returns a generated id', async () => {
    const [rendered] = adapter.render([{ type: 'TEXT', text: 'Hello' }], config);
    if (!rendered) throw new Error('nothing rendered');
    const target = { identityKind: 'webchat_visitor', identityValue: 'v_visitor_one', lastInboundAt: null };
    const noMedia = { signedUrl: () => Promise.reject(new Error('unused')), read: () => Promise.reject(new Error('unused')) };
    expect(await adapter.send(target, rendered, config, noMedia)).toEqual({ ok: true, externalMessageId: 'webchat-out:fixed-id' });
    const foreign: RenderedOutbound = { kind: 'WHATSAPP', payload: { type: 'text', body: 'x', previewUrl: false }, partIndexes: [] };
    expect(await adapter.send(target, foreign, config, noMedia)).toMatchObject({ ok: false, errorCode: 'invalid_payload' });
    expect(await adapter.send({ ...target, identityKind: 'whatsapp_phone' }, rendered, config, noMedia)).toMatchObject({ errorCode: 'invalid_recipient' });
  });

  it('fetchMedia is not applicable', async () => {
    await expect(adapter.fetchMedia({ status: 'STORED', mimeType: 'image/png', blobKey: 'k' }, config)).rejects.toBeInstanceOf(ChannelMediaError);
    await expect(adapter.fetchMedia({ status: 'STORED', mimeType: 'image/png', blobKey: 'k' }, config)).rejects.toMatchObject({ code: 'media_not_applicable' });
  });

  it('declares streaming commonmark capabilities with no session window', () => {
    expect(adapter.capabilities(config)).toMatchObject({ streaming: true, markdown: 'commonmark', sessionWindowHours: null, deliveryReceipts: false });
  });
});
