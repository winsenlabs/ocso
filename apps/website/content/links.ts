/**
 * Links and names used across the site. Every product claim on the site is checked against the repository
 * (README.md, docs/); links point at the public repo.
 */

/** Public origin of this site: canonical URLs, sitemap, llms.txt and email images. */
export const siteUrl = (process.env['OCSO_SITE_URL'] ?? 'https://ocso.winsenlabs.dev').replace(/\/+$/, '');

export const NAME = 'Open Customer Service Orchestration';
export const REPO_URL = 'https://github.com/winsenlabs/ocso';
export const WINSEN_URL = 'https://winsenlabs.com';
/** Where people write to us. Not in the repository docs; confirm with the owner (also EMAIL_REPLY_TO). */
export const helloEmail = 'hello@winsenlabs.com';

/** A file or folder in the repository on GitHub. */
export const repo = (path: string): string => `${REPO_URL}/${path.endsWith('/') ? 'tree' : 'blob'}/main/${path.replace(/\/$/, '')}`;

export const SITE_TITLE = `OCSO — ${NAME}`;
export const SITE_DESCRIPTION =
  'Customer service is scattered across channels, tools and teams. OCSO is one open, self-hosted orchestration layer where AI agents and your people serve every customer on WhatsApp, web chat, Slack and Microsoft Teams, with maker–checker approvals and a signed audit trail.';

/** In-page sections, in order (navigation and anchors). */
export const SECTIONS = [
  { id: 'problem', label: 'The problem' },
  { id: 'the-ocso-way', label: 'The OCSO way' },
  { id: 'governance', label: 'Governance' },
  { id: 'open-source', label: 'Open source' },
] as const;

/** The 60-second film, on YouTube. The site shows its own poster and only loads YouTube when someone presses play. */
export const FILM = {
  id: 'ZP__hoKtt68',
  title: 'OCSO in 60 seconds',
  url: 'https://youtu.be/ZP__hoKtt68',
  embed: 'https://www.youtube-nocookie.com/embed/ZP__hoKtt68',
  poster: '/video/ocso-film-poster.webp',
} as const;

/**
 * What link previews get: the film as og:video (Facebook, LinkedIn, Slack, Discord and Telegram can play or unfurl
 * it) and an X player card. WhatsApp and iMessage show the share image only; it carries a play button.
 */
export const FILM_SHARE = {
  openGraph: {
    images: [{ url: '/opengraph-image.jpg', width: 1200, height: 630, alt: 'OCSO in 60 seconds: a play button over the plugin core' }],
    videos: [{ url: `https://www.youtube.com/embed/${FILM.id}`, secureUrl: `https://www.youtube.com/embed/${FILM.id}`, type: 'text/html', width: 1280, height: 720 }],
  },
  twitter: { card: 'player' as const, images: ['/opengraph-image.jpg'] },
  // Written by hand: Next's player descriptor insists on a raw stream URL, and YouTube has none to give.
  other: { 'twitter:player': `https://www.youtube.com/embed/${FILM.id}`, 'twitter:player:width': '1280', 'twitter:player:height': '720' },
};
