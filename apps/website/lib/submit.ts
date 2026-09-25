import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { allFields, validate, type FormDef } from '@/content/forms';
import { helloEmail } from '@/content/links';
import { d1 } from './d1';
import { acknowledgement, slackNotification } from './emails';
import { serverEnv } from './env';
import { sendEmail } from './mail';
import { allow, clientIp } from './rate-limit';

const MAX_BODY = 32 * 1024;

/**
 * Stores a demo request, then sends the acknowledgement and the Slack notification (store first, then email).
 * The row is the record: once it is written the request succeeds even if an email fails, and the
 * ack_sent_at / slack_sent_at columns show what was delivered.
 */
export async function handleSubmission(def: FormDef, req: Request) {
  const ip = clientIp(req);
  if (!allow(ip)) return NextResponse.json({ error: `Too many requests from your network. Please try again later, or email ${helloEmail}.` }, { status: 429 });

  const raw = await req.text().catch(() => '');
  if (!raw || raw.length > MAX_BODY) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Honeypot: people never see this field, bots fill it. Pretend success.
  if (typeof body['company_fax'] === 'string' && body['company_fax']) return NextResponse.json({ ok: true });

  const fields = allFields(def);
  const errors = validate(fields, body);
  if (Object.keys(errors).length) return NextResponse.json({ error: 'Check the highlighted fields', errors }, { status: 422 });

  const values: Record<string, string> = {};
  for (const f of fields) {
    const v = body[f.name];
    values[f.name] = f.type === 'multi' ? (v as string[]).join(', ') : typeof v === 'string' ? v.trim() : '';
  }
  values['email'] = values['email']!.toLowerCase();

  const id = randomUUID();
  // The address is kept only as a salted hash, for spotting abuse; the salt is the database id.
  const ipHash = createHash('sha256').update(`${serverEnv().databaseId ?? ''}:${ip}`).digest('hex').slice(0, 32);
  const sourcePage = typeof body['source_page'] === 'string' ? body['source_page'].slice(0, 200) : null;
  const columns = ['id', ...fields.map((f) => f.name), 'source_page', 'ip_hash'];
  const params = [id, ...fields.map((f) => values[f.name] || null), sourcePage, ipHash];

  try {
    await d1(`INSERT INTO ${def.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, params);
  } catch (err) {
    console.error(`[${def.kind}] could not store request`, err);
    return NextResponse.json({ error: `We couldn't send that just now. Please try again, or email ${helloEmail}.` }, { status: 503 });
  }

  const { slackEmail, replyTo } = serverEnv();
  const [ack, slack] = await Promise.allSettled([
    sendEmail(acknowledgement(def, values, replyTo)),
    slackEmail ? sendEmail(slackNotification(def, values, { id, to: slackEmail })) : Promise.reject(new Error('SLACK_NOTIFY_EMAIL is not set')),
  ]);
  if (ack.status === 'rejected') console.error(`[${def.kind}] ${id} acknowledgement failed`, ack.reason);
  if (slack.status === 'rejected') console.error(`[${def.kind}] ${id} Slack notification failed`, slack.reason);

  const now = new Date().toISOString();
  await d1(`UPDATE ${def.table} SET ack_sent_at = ?, slack_sent_at = ? WHERE id = ?`, [
    ack.status === 'fulfilled' ? now : null,
    slack.status === 'fulfilled' ? now : null,
    id,
  ]).catch((err: unknown) => console.error(`[${def.kind}] ${id} could not record delivery`, err));

  console.info(`[${def.kind}] ${id} stored; ack ${ack.status}, slack ${slack.status}`);
  return NextResponse.json({ ok: true, id });
}
