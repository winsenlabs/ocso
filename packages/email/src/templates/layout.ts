import type { RenderedEmail } from '../contract.js';
import { escapeHtml, oneLine, safeUrl } from './escape.js';

/**
 * Shared minimal layout: one centered 560 px card, table-based for Outlook,
 * inline styles only (many clients strip <style>), system fonts, no images,
 * no tracking pixels, no external resources. Every template produces its
 * plain-text alternative from the same blocks, so both parts always agree.
 */
export type EmailBlock =
  | { kind: 'text'; text: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'code'; code: string }
  | { kind: 'facts'; rows: ReadonlyArray<readonly [label: string, value: string]> }
  | { kind: 'note'; text: string };

export interface LayoutInput {
  /** Organization name (deployment settings) shown above the heading and in the footer. */
  org: string;
  subject: string;
  heading: string;
  /** Inbox preview line; defaults to nothing. */
  preheader?: string | undefined;
  blocks: readonly EmailBlock[];
}

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const INK = '#1f2328';
const MUTED = '#5f6570';
const ACCENT = '#1f5fd6';

export function renderLayout(input: LayoutInput): RenderedEmail {
  const org = oneLine(input.org, 120) || 'your organization';
  const subject = oneLine(input.subject, 200);
  const heading = oneLine(input.heading, 200);
  const blocks = input.blocks.map(normalize);
  return { subject, html: html(org, subject, heading, input.preheader, blocks), text: text(org, heading, blocks) };
}

function normalize(block: EmailBlock): EmailBlock {
  return block.kind === 'button' ? { ...block, url: safeUrl(block.url, `"${block.label}" link`) } : block;
}

/** Escape, keeping the author's line breaks. */
const para = (value: string): string => escapeHtml(value).replace(/\r?\n/g, '<br>');

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'text':
      return `<p style="margin:0 0 16px">${para(block.text)}</p>`;
    case 'note':
      return `<p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:${MUTED}">${para(block.text)}</p>`;
    case 'code':
      return `<p style="margin:4px 0 20px;${MONO};font-size:30px;line-height:1.2;font-weight:600;letter-spacing:6px;color:${INK}">${escapeHtml(block.code)}</p>`;
    case 'facts': {
      const rows = block.rows
        .map(([label, value]) => `<tr><td style="padding:3px 16px 3px 0;color:${MUTED};white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="padding:3px 0;color:${INK}">${para(value)}</td></tr>`)
        .join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;${FONT};font-size:14px;line-height:1.45">${rows}</table>`;
    }
    case 'button': {
      const href = escapeHtml(block.url);
      return [
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 16px"><tr>`,
        `<td style="border-radius:6px;background:${ACCENT}" bgcolor="${ACCENT}">`,
        `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 22px;${FONT};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:6px">${escapeHtml(block.label)}</a>`,
        `</td></tr></table>`,
        `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${MUTED}">If the button does not work, paste this link into your browser:<br>`,
        `<a href="${href}" target="_blank" rel="noopener" style="color:${ACCENT};word-break:break-all">${href}</a></p>`,
      ].join('');
    }
  }
}

function html(org: string, subject: string, heading: string, preheader: string | undefined, blocks: readonly EmailBlock[]): string {
  const pre = preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(oneLine(preheader, 150))}</div>` : '';
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">${pre}`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6"><tr><td align="center" style="padding:24px 12px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid #e1e4e8;border-radius:8px">`,
    `<tr><td style="padding:22px 28px 0;${FONT};font-size:13px;line-height:1.4;font-weight:600;color:${MUTED}">${escapeHtml(org)}</td></tr>`,
    `<tr><td style="padding:10px 28px 6px;${FONT};font-size:20px;line-height:1.35;font-weight:600;color:${INK}">${escapeHtml(heading)}</td></tr>`,
    `<tr><td style="padding:8px 28px 12px;${FONT};font-size:15px;line-height:1.55;color:${INK}">${blocks.map(blockHtml).join('')}</td></tr>`,
    '</table>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px"><tr>`,
    `<td style="padding:14px 28px;${FONT};font-size:12px;line-height:1.5;color:${MUTED}">Sent by OCSO for ${escapeHtml(org)}.</td></tr></table>`,
    '</td></tr></table></body></html>',
  ].join('\n');
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'text':
    case 'note':
      return block.text;
    case 'code':
      return `    ${block.code}`;
    case 'button':
      return `${block.label}: ${block.url}`;
    case 'facts':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n');
  }
}

function text(org: string, heading: string, blocks: readonly EmailBlock[]): string {
  return [org, '', heading, '', ...blocks.flatMap((b) => [blockText(b), '']), '--', `Sent by OCSO for ${org}.`, ''].join('\n');
}
