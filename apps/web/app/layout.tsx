import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
// Design system, in the order the mockups load it (design/*.dc.html), then app additions.
import './styles/base.css';
import './styles/one.css';
import './styles/charts.css';
import './styles/mock.css';
import './styles/ocso.css';
import './styles/app.css';

// Self-hosted variable fonts (OFL-1.1, @fontsource-variable): builds need no network
// access to Google Fonts and the running app makes no third-party font requests.
const inter = localFont({ src: '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '100 900', variable: '--font-inter', display: 'swap' });
const mono = localFont({
  src: '../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

/** Icons, the web manifest and the Open Graph card come from app/ file conventions (brand/ holds the sources). */
export function generateMetadata(): Metadata {
  const publicUrl = process.env['OCSO_PUBLIC_URL'];
  return {
    ...(publicUrl ? { metadataBase: new URL(publicUrl) } : {}),
    title: { default: 'OCSO', template: '%s — OCSO' },
    applicationName: 'OCSO',
    description: 'Open Customer Service Orchestrator',
    openGraph: { title: 'OCSO', description: 'Open Customer Service Orchestrator', siteName: 'OCSO', type: 'website' },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F9FCFE' },
    { media: '(prefers-color-scheme: dark)', color: '#090E12' },
  ],
};

/** Applies the saved theme before first paint (same key as design/OCSONav). */
const THEME_SCRIPT =
  "(function(){try{var t=localStorage.getItem('ocso-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}})()";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
