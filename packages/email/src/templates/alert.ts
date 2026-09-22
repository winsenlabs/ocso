import type { RenderedEmail } from '../contract.js';
import { oneLine } from './escape.js';
import { renderLayout, type EmailBlock } from './layout.js';

/**
 * Alert notification (docs/11 §7). @ocso/alerts renders the channel-neutral
 * fields (renderAlert) and hands them here, so SMTP destinations and the
 * deployment sender produce the same email.
 */
export interface AlertEmailInput {
  /** Deployment label shown in the header/footer, e.g. "Meridian Bank · PROD". */
  org: string;
  title: string;
  /** Severity tag as text: INFO, WARNING, CRITICAL — or RESOLVED once closed. */
  severity: string;
  /** What happened (alert body; may span lines). */
  summary: string;
  /** Extra label/value rows (severity, source, value, state…). */
  fields?: ReadonlyArray<readonly [string, string]> | undefined;
  /** Deep link into OCSO; omitted when no public URL is configured. */
  link?: string | null | undefined;
  /** Small print, e.g. "Alert 0192f…". */
  reference?: string | null | undefined;
}

export function alertEmail(input: AlertEmailInput): RenderedEmail {
  const tag = oneLine(input.severity, 20).toUpperCase();
  const title = oneLine(input.title, 180);
  const blocks: EmailBlock[] = [{ kind: 'text', text: input.summary }];
  if (input.fields?.length) blocks.push({ kind: 'facts', rows: input.fields });
  if (input.link) blocks.push({ kind: 'button', label: 'Open in OCSO', url: input.link });
  if (input.reference) blocks.push({ kind: 'note', text: input.reference });
  return renderLayout({
    org: input.org,
    subject: `[OCSO ${tag}] ${title}`,
    heading: `[${tag}] ${title}`,
    preheader: oneLine(input.summary, 140),
    blocks,
  });
}
