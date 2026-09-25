import 'server-only';
import { allFields, type FormDef } from '@/content/forms';
import { NAME, REPO_URL, WINSEN_URL, siteUrl } from '@/content/links';
import type { Email } from './mail';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const host = (url: string) => url.replace(/^https?:\/\//, '');

type Values = Record<string, string>;
type Row = { label: string; value: string };

const rows = (def: FormDef, values: Values): Row[] => allFields(def).filter((f) => values[f.name]).map((f) => ({ label: f.label, value: values[f.name]! }));

/** The shared frame: dark branded header in the OCSO accent, white card, quiet footer. Table layout for email clients. */
function layout({ preheader, heading, body, footer }: { preheader: string; heading: string; body: string; footer: string }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#11171d;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f7;">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;">
      <tr><td bgcolor="#0b1024" style="background:#0b1024;background-image:linear-gradient(135deg,#3d5dcf 0%,#141d4d 48%,#05070d 100%);padding:28px 36px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;"><img src="${siteUrl}/brand/ocso-mark.png" width="36" height="36" alt="OCSO" style="display:block;border:0;border-radius:10px;"></td>
          <td style="vertical-align:middle;padding-left:12px;color:#ffffff;font-size:17px;font-weight:600;letter-spacing:-0.01em;">OCSO</td>
        </tr></table>
        <p style="margin:36px 0 0;color:#ffffff;font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;">${esc(heading)}</p>
      </td></tr>
      <tr><td style="padding:32px 36px 12px;font-size:16px;line-height:1.6;color:#1f2933;">${body}</td></tr>
      <tr><td style="padding:24px 36px 32px;border-top:1px solid #e6e9f2;font-size:13px;line-height:1.6;color:#66707c;">${footer}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function summaryTable(items: Row[]) {
  const trs = items
    .map(
      (r) => `<tr>
        <td style="padding:10px 12px 10px 0;border-bottom:1px solid #eef0f6;font-size:13px;color:#66707c;width:38%;vertical-align:top;">${esc(r.label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eef0f6;font-size:14px;color:#11171d;vertical-align:top;white-space:pre-wrap;">${esc(r.value)}</td>
      </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">${trs}</table>`;
}

function button(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr>
    <td bgcolor="#3d5dcf" style="border-radius:12px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${esc(label)}</a></td>
  </tr></table>`;
}

const p = (html: string) => `<p style="margin:0 0 16px;">${html}</p>`;

/** The acknowledgement to the person who asked for a demo. */
export function acknowledgement(def: FormDef, values: Values, replyTo: string): Email {
  const items = rows(def, values);
  const name = firstName(values['name'] ?? '');
  const lead = 'Thank you for asking for a demo of OCSO. Your request is with the Winsen Labs team.';
  const next = [
    'Someone from our team reads your answers and replies personally.',
    'We set up a walkthrough around your channels, volumes and the way your team hands customers between AI and people.',
    'If it is a fit, we talk about building it with you. We take on a small number of engagements at a time.',
  ];
  const body =
    p(`Hi ${esc(name)},`) +
    p(esc(lead)) +
    `<p style="margin:0 0 8px;font-weight:600;color:#11171d;">What happens next</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">${next
      .map((n, i) => `<tr><td style="padding:4px 12px 4px 0;vertical-align:top;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#3d5dcf;">0${i + 1}</td><td style="padding:4px 0;font-size:15px;color:#1f2933;">${esc(n)}</td></tr>`)
      .join('')}</table>` +
    p('Here’s a copy of what you sent:') +
    summaryTable(items) +
    p('While you wait, the code is open:') +
    button(REPO_URL, 'View OCSO on GitHub') +
    p(`Just reply to this email if there’s anything to add. It reaches us at ${esc(replyTo)}.`) +
    `<p style="margin:0;">The Winsen Labs team</p>`;
  const footer = `OCSO, ${esc(NAME)}. Open source, built by <a href="${WINSEN_URL}" style="color:#3d5dcf;text-decoration:none;">Winsen Labs</a>.<br>
    Questions: <a href="mailto:${esc(replyTo)}" style="color:#3d5dcf;text-decoration:none;">${esc(replyTo)}</a> &nbsp;·&nbsp; <a href="${siteUrl}" style="color:#66707c;">${esc(host(siteUrl))}</a><br>
    <span style="color:#8a929c;">You’re receiving this because you asked for a demo on ${esc(host(siteUrl))}. We use these details only to reply to you.</span>`;
  const text = [
    `Hi ${name},`,
    '',
    lead,
    '',
    'What happens next',
    ...next.map((n, i) => `0${i + 1}  ${n}`),
    '',
    'What you sent:',
    ...items.map((r) => `${r.label}: ${r.value}`),
    '',
    `The code is open: ${REPO_URL}`,
    '',
    `Just reply to this email if there's anything to add (${replyTo}).`,
    'The Winsen Labs team',
    '',
    `OCSO, ${NAME} · ${siteUrl} · ${WINSEN_URL}`,
  ].join('\n');
  return { to: values['email']!, subject: 'We’ve received your OCSO demo request', html: layout({ preheader: lead, heading: 'We’ve received your request.', body, footer }), text };
}

/** The notification to the team's Slack channel email: every field, and a button that replies to the requester. */
export function slackNotification(def: FormDef, values: Values, meta: { id: string; to: string }): Email {
  const items = rows(def, values);
  const name = values['name'] ?? 'the requester';
  const subject = `[OCSO demo] ${name}, ${values['company']} · ${values['team_size']} CS team · ${values['conversations']} conversations/mo`;
  const mailto = `mailto:${values['email']}?subject=${encodeURIComponent('Your OCSO demo request')}&body=${encodeURIComponent(`Hi ${firstName(name)},\n\n`)}`;
  const body =
    p(`New demo request on ${esc(host(siteUrl))} from <strong>${esc(name)}</strong> (${esc(values['role'] ?? '')}) at <strong>${esc(values['company'] ?? '')}</strong>.`) +
    button(mailto, `Reply to ${firstName(name)}`) +
    summaryTable(items) +
    `<p style="margin:0;color:#66707c;font-size:12px;">Request ${esc(meta.id)} · D1 ocso-site, table ${esc(def.table)}</p>`;
  const text = [
    `New OCSO demo request on ${host(siteUrl)}`,
    '',
    ...items.map((r) => `${r.label}: ${r.value}`),
    '',
    `Reply: ${values['email']}`,
    `Request ${meta.id} · D1 ocso-site, table ${def.table}`,
  ].join('\n');
  const footer = `Sent by the OCSO website. Replying to this email goes to ${esc(values['email'] ?? '')}.`;
  return { to: meta.to, subject, html: layout({ preheader: `${name}, ${values['company']}`, heading: `Demo request: ${values['company']}`, body, footer }), text, replyTo: values['email'] };
}
