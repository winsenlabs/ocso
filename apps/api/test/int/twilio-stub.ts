import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for api.twilio.com (Messages) and content.twilio.com
 * (Content API: templates and their WhatsApp approval), in the recorded
 * shapes of PM/research/06 and 10. Requests are recorded; approval status is
 * mutable so tests can play WhatsApp's review.
 */

export interface StubContent {
  item: Record<string, unknown>;
  approval: Record<string, unknown> | null;
}

export interface TwilioStub {
  url: string;
  contents: Map<string, StubContent>;
  requests: Array<{ method: string; path: string; body: string }>;
  approve(sid: string, status: string, rejectionReason?: string): void;
  close(): Promise<void>;
}

const hex = () => randomBytes(16).toString('hex');

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startTwilioStub(accountSid: string, authToken: string, seed: StubContent[] = []): Promise<TwilioStub> {
  const contents = new Map(seed.map((c) => [String(c.item['sid']), c]));
  const requests: TwilioStub['requests'] = [];
  const expected = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '', body });
    if (req.headers.authorization !== expected) return send(res, 401, { code: 20003, message: 'Authenticate', status: 401 });
    if (req.method === 'POST' && path === `/2010-04-01/Accounts/${accountSid}/Messages.json`) return send(res, 201, { sid: `SM${hex()}`, status: 'queued' });
    if (req.method === 'GET' && path === '/v1/ContentAndApprovals') {
      const list = [...contents.values()].map((c) => ({ ...c.item, approval_requests: c.approval ?? { name: '', category: '', content_type: '', status: 'unsubmitted', rejection_reason: '' } }));
      return send(res, 200, { contents: list, meta: { page: 0, page_size: 500, next_page_url: null, key: 'contents' } });
    }
    const match = /^\/v1\/Content(?:\/(HX[0-9a-f]{32}))?(\/ApprovalRequests(?:\/whatsapp)?)?$/.exec(path);
    if (!match) return send(res, 404, { code: 20404, message: 'not found', status: 404 });
    const [, sid, approvalPath] = match;
    if (!sid && req.method === 'POST') {
      const created = { sid: `HX${hex()}`, account_sid: accountSid, ...(JSON.parse(body) as Record<string, unknown>) };
      contents.set(created.sid, { item: created, approval: null });
      return send(res, 201, created);
    }
    const content = sid ? contents.get(sid) : undefined;
    if (!content) return send(res, 404, { code: 20404, message: 'The requested resource was not found', status: 404 });
    if (req.method === 'DELETE' && !approvalPath) {
      contents.delete(sid!);
      return send(res, 204);
    }
    if (req.method === 'POST' && approvalPath === '/ApprovalRequests/whatsapp') {
      const { name, category } = JSON.parse(body) as { name: string; category: string };
      content.approval = { name, category, content_type: Object.keys((content.item['types'] as object) ?? {})[0] ?? '', status: 'received', rejection_reason: '', allow_category_change: true };
      return send(res, 201, content.approval);
    }
    if (req.method === 'GET' && approvalPath === '/ApprovalRequests') return send(res, 200, { sid, account_sid: accountSid, whatsapp: content.approval });
    if (req.method === 'GET' && !approvalPath) return send(res, 200, content.item);
    return send(res, 405, { message: 'method not allowed' });
  };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => handle(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    contents,
    requests,
    approve(sid, status, rejectionReason = '') {
      const content = contents.get(sid);
      if (content?.approval) content.approval = { ...content.approval, status, rejection_reason: rejectionReason };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Seed content in the recorded ContentAndApprovals shape (PM/research/10 §11.1). */
export function seededContent(sid: string, name: string, body: string, variables: Record<string, string>, status: string): StubContent {
  return {
    item: { sid, friendly_name: name, language: 'en', variables, types: { 'twilio/text': { body } } },
    approval: { name, category: 'UTILITY', content_type: 'twilio/text', status, rejection_reason: '', allow_category_change: true },
  };
}
