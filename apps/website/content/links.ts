/**
 * Links and names used across the site. Every product claim on the site is checked against the repository
 * (README.md, docs/); links point at the public repo.
 */

/** Public origin of this site: canonical URLs, sitemap, llms.txt and email images. */
export const siteUrl = (process.env['OCSO_SITE_URL'] ?? 'https://ocso.winsenlabs.dev').replace(/\/+$/, '');

export const NAME = 'Open Customer Success Orchestration';
export const REPO_URL = 'https://github.com/winsenlabs/ocso';
export const WINSEN_URL = 'https://winsenlabs.com';
/** Where people write to us. Not in the repository docs; confirm with the owner (also EMAIL_REPLY_TO). */
export const helloEmail = 'hello@winsenlabs.com';

/** A file or folder in the repository on GitHub. */
export const repo = (path: string): string => `${REPO_URL}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${path.replace(/\/$/, '')}`;

export const SITE_TITLE = `OCSO — ${NAME}`;
export const SITE_DESCRIPTION =
  'Customer success is scattered across channels, tools and teams. OCSO is one open, self-hosted orchestration layer where AI agents and your people serve every customer on WhatsApp, web chat, Slack and Microsoft Teams, with maker–checker approvals and a signed audit trail.';

/** In-page sections, in order (navigation and anchors). */
export const SECTIONS = [
  { id: 'problem', label: 'The problem' },
  { id: 'the-ocso-way', label: 'The OCSO way' },
  { id: 'governance', label: 'Governance' },
  { id: 'open-source', label: 'Open source' },
] as const;
