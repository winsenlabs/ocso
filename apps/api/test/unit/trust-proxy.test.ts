import { ExpressAdapter } from '@nestjs/platform-express';
import type { Express, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { trustProxySetting } from '../../src/common/trust-proxy.js';

function ipEcho(setting: string): Express {
  const app = new ExpressAdapter().getInstance<Express>();
  app.set('trust proxy', trustProxySetting(setting));
  app.get('/', (req: Request, res: Response) => res.send(req.ip));
  return app;
}

describe('TRUST_PROXY', () => {
  it('parses true/false/hop counts and refuses anything else', () => {
    expect(trustProxySetting(undefined)).toBe(true);
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('0')).toBe(false);
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('2')).toBe(2);
    expect(() => trustProxySetting('yes')).toThrow(/TRUST_PROXY/);
  });

  it('with a hop count, a client-supplied X-Forwarded-For entry cannot choose req.ip', async () => {
    const app = ipEcho('1');
    // The client forged 203.0.113.9; the trusted proxy appended the real address 198.51.100.7.
    const res = await request(app).get('/').set('x-forwarded-for', '203.0.113.9, 198.51.100.7');
    expect(res.text).toBe('198.51.100.7');
    const all = ipEcho('true');
    expect((await request(all).get('/').set('x-forwarded-for', '203.0.113.9, 198.51.100.7')).text).toBe('203.0.113.9');
  });
});
