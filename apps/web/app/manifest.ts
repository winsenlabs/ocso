import type { MetadataRoute } from 'next';

/** Installable app metadata (Add to Home Screen); icons are rendered from brand/ocso-mark.svg. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OCSO — Open Customer Service Orchestrator',
    short_name: 'OCSO',
    start_url: '/',
    display: 'standalone',
    background_color: '#F9FCFE',
    theme_color: '#11171D',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
