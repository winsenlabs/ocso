import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/index.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const log = pino(loggerOptions({ service: 'test', version: '1', level: 'info' }), stream);
  return { log, lines };
}

describe('logger redaction', () => {
  it('never writes credentials', () => {
    const { log, lines } = capture();
    log.info(
      {
        req: { headers: { authorization: 'Bearer abc123', cookie: 'ocso_session=zzz' } },
        provider: { apiKey: 'sk-live-999', name: 'openai' },
        oauth: { accessToken: 'at-1', refreshToken: 'rt-1', codeVerifier: 'cv' },
      },
      'request',
    );
    const out = lines.join('');
    for (const secret of ['abc123', 'zzz', 'sk-live-999', 'at-1', 'rt-1']) expect(out).not.toContain(secret);
    expect(out).toContain('openai');
    expect(JSON.parse(lines[0]!).service).toBe('test');
  });
});
