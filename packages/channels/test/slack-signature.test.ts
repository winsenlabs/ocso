import { describe, expect, it } from 'vitest';
import { createSlackChannelAdapter, slackSignature, verifySlackSignature } from '../src/index.js';
import { NOW, NOW_SECONDS, SIGNING_SECRET, slackRequest, slackSign, slConfig } from './helpers/slack.js';

const adapter = createSlackChannelAdapter({ now: () => NOW });
const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message' } });

describe('Slack request signing', () => {
  it('computes the same v0 signature as Slack’s reference', () => {
    expect(slackSignature(SIGNING_SECRET, NOW_SECONDS, body)).toBe(slackSign(body));
    expect(slackSignature(SIGNING_SECRET, NOW_SECONDS, Buffer.from(body))).toBe(slackSign(body));
  });

  it('accepts a correctly signed request inside the window', () => {
    expect(adapter.verifyRequest(slackRequest(body), slConfig())).toEqual({ kind: 'verified' });
    const fourMinutesAgo = String(Number(NOW_SECONDS) - 240);
    expect(adapter.verifyRequest(slackRequest(body, { timestamp: fourMinutesAgo }), slConfig())).toEqual({ kind: 'verified' });
  });

  it('refuses a request older or newer than five minutes (replay window)', () => {
    for (const timestamp of [String(Number(NOW_SECONDS) - 301), String(Number(NOW_SECONDS) + 301)]) {
      expect(adapter.verifyRequest(slackRequest(body, { timestamp }), slConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    }
  });

  it('refuses a tampered body, a wrong secret and a signature for another timestamp', () => {
    const signed = slackRequest(body);
    expect(adapter.verifyRequest({ ...signed, rawBody: Buffer.from(body.replace('Ev1', 'Ev2')) }, slConfig())).toMatchObject({ kind: 'rejected', status: 403 });
    expect(adapter.verifyRequest(slackRequest(body, { signature: slackSign(body, NOW_SECONDS, 'another0secret0value00') }), slConfig())).toMatchObject({ kind: 'rejected', status: 403 });
    expect(adapter.verifyRequest(slackRequest(body, { signature: slackSign(body, String(Number(NOW_SECONDS) - 1)) }), slConfig())).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('refuses missing or malformed headers, GETs and an unconfigured secret', () => {
    expect(adapter.verifyRequest(slackRequest(body, { signature: null }), slConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    expect(adapter.verifyRequest(slackRequest(body, { signature: 'v1=abc' }), slConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    expect(adapter.verifyRequest(slackRequest(body, { timestamp: 'yesterday' }), slConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    expect(adapter.verifyRequest(slackRequest(body, { method: 'GET' }), slConfig())).toMatchObject({ kind: 'rejected', status: 400 });
    expect(verifySlackSignature(slackRequest(body), '', NOW)).toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('answers a signed url_verification with its challenge, and refuses an unsigned or unsafe one', () => {
    const challenge = JSON.stringify({ token: 'x', type: 'url_verification', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
    expect(adapter.verifyRequest(slackRequest(challenge), slConfig())).toEqual({ kind: 'challenge', status: 200, body: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
    expect(adapter.verifyRequest(slackRequest(challenge, { signature: null }), slConfig())).toMatchObject({ kind: 'rejected', status: 401 });
    const unsafe = JSON.stringify({ type: 'url_verification', challenge: '<script>alert(1)</script>' });
    expect(adapter.verifyRequest(slackRequest(unsafe), slConfig())).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('verifies with the signing secret even when settings are invalid', () => {
    expect(adapter.verifyRequest(slackRequest(body), slConfig({ respondTo: 'everyone' }))).toEqual({ kind: 'verified' });
  });

  it('acknowledges with an empty 200', () => {
    expect(adapter.webhookAcknowledgement()).toEqual({ status: 200, contentType: 'text/plain', body: '' });
  });
});
