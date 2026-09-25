/**
 * Site-wide constants. Every claim on the site is checked against the repository
 * (README.md, docs/, PM/ARCHITECTURE-DECISIONS.md); links point at the public repo.
 */

/** Public origin of this site, for canonical URLs, the sitemap and Open Graph (build-time). */
export const SITE_URL = (process.env['OCSO_SITE_URL'] ?? 'https://ocso.winsenlabs.dev').replace(/\/+$/, '');

export const REPO_URL = 'https://github.com/winsenlabs/ocso';
export const DEMO_URL = 'https://demo.ocso.winsenlabs.dev';
export const DOCS_URL = `${REPO_URL}/tree/main/docs`;

/** A file or folder in the repository on GitHub. */
export const repo = (path: string): string => `${REPO_URL}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${path.replace(/\/$/, '')}`;

export const SITE_TITLE = 'OCSO — One Customer Success Orchestrator';
export const SITE_DESCRIPTION =
  'Open-source, self-hosted runtime for AI agents and human service teams on WhatsApp, web chat, Slack and Microsoft Teams, with maker–checker approvals and a signed audit trail.';

export interface NavItem {
  readonly id: string;
  readonly label: string;
}

/** In-page sections, in order (header navigation and anchors). */
export const SECTIONS: readonly NavItem[] = [
  { id: 'channels', label: 'Channels' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'governance', label: 'Governance' },
  { id: 'ask-ocso', label: 'Ask OCSO' },
  { id: 'build', label: 'Build on it' },
  { id: 'self-host', label: 'Self-host' },
];
